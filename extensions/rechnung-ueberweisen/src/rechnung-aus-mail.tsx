import { Action, ActionPanel, Icon, List, showToast, Toast, useNavigation } from "@raycast/api";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, open, rm, rmdir, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { useEffect, useState } from "react";
import { InvoiceForm } from "./rechnung-ueberweisen";

const execFileAsync = promisify(execFile);
const FIELD = String.fromCharCode(31);
const RECORD = String.fromCharCode(30);
const MAX_PDF_BYTES = 30 * 1024 * 1024;

type MailPdf = {
  key: string;
  account: string;
  mailbox: string;
  messageId: string;
  attachmentIndex: number;
  subject: string;
  sender: string;
  filename: string;
  received: string;
};

// ASCII 30/31 trennen Datensätze/Felder. Steuerzeichen in Mail-Metadaten
// werden durch Leerzeichen ersetzt, damit sie die Struktur nicht zerstören.
const listScript = `
on cleanField(inputValue)
    set valueText to inputValue as string
    repeat with badCharacter in {tab, return, linefeed, ASCII character 30, ASCII character 31}
        set AppleScript's text item delimiters to badCharacter
        set chunks to text items of valueText
        set AppleScript's text item delimiters to " "
        set valueText to chunks as string
    end repeat
    set AppleScript's text item delimiters to ""
    return valueText
end cleanField

on run argv
    if (count of argv) is not 2 then error "Ungültige Argumentanzahl"
    set startOffset to item 1 of argv as integer
    set requestedCount to item 2 of argv as integer
    if startOffset < 0 or requestedCount < 1 or requestedCount > 100 then error "Ungültiger Suchbereich"
    tell application "Mail"
        set inboxMessages to messages of inbox
        set messageCount to count of inboxMessages
        set firstIndex to startOffset + 1
        set lastIndex to startOffset + requestedCount
        if lastIndex > messageCount then set lastIndex to messageCount
        set processedCount to 0
        set outputLines to {}
        if firstIndex <= lastIndex then
            repeat with i from firstIndex to lastIndex
                set processedCount to processedCount + 1
                set currentMessage to item i of inboxMessages
                try
                    set attachmentsList to mail attachments of currentMessage
                    set pdfPositions to {}
                    repeat with j from 1 to count of attachmentsList
                        set originalName to name of item j of attachmentsList
                        ignoring case
                            set isPDF to originalName ends with ".pdf"
                        end ignoring
                        if isPDF then set end of pdfPositions to j
                    end repeat
                    if (count of pdfPositions) > 0 then
                        set currentMailbox to mailbox of currentMessage
                        set accountName to my cleanField(name of account of currentMailbox)
                        set mailboxName to my cleanField(name of currentMailbox)
                        set messageId to id of currentMessage as string
                        set messageSubject to my cleanField(subject of currentMessage)
                        set messageSender to my cleanField(sender of currentMessage)
                        set messageDate to my cleanField(date received of currentMessage)
                        repeat with j in pdfPositions
                            set attachmentName to my cleanField(name of item j of attachmentsList)
                            set end of outputLines to accountName & (ASCII character 31) & mailboxName & (ASCII character 31) & messageId & (ASCII character 31) & (j as string) & (ASCII character 31) & messageSubject & (ASCII character 31) & messageSender & (ASCII character 31) & attachmentName & (ASCII character 31) & messageDate
                        end repeat
                    end if
                end try
            end repeat
        end if
        set outputLines to {(processedCount as string) & (ASCII character 31) & (messageCount as string)} & outputLines
        set AppleScript's text item delimiters to ASCII character 30
        return outputLines as string
    end tell
end run
`;

// Argumente werden separat an osascript übergeben, nicht in Skript- oder Shell-Text eingesetzt.
const saveScript = `
on run argv
    if (count of argv) is not 6 then error "Ungültige Argumentanzahl"
    set accountName to item 1 of argv
    set mailboxName to item 2 of argv
    set messageId to item 3 of argv as integer
    set attachmentIndex to item 4 of argv as integer
    set expectedFilename to item 5 of argv
    set destinationPath to item 6 of argv
    tell application "Mail"
        set targetAccount to first account whose name is accountName
        set targetMailbox to first mailbox of targetAccount whose name is mailboxName
        set targetMessage to first message of targetMailbox whose id is messageId
        set attachmentList to mail attachments of targetMessage
        if attachmentIndex < 1 or attachmentIndex > count of attachmentList then error "Anhang nicht mehr vorhanden"
        set chosenAttachment to item attachmentIndex of attachmentList
        if (name of chosenAttachment) is not expectedFilename then error "Anhang stimmt nicht mehr überein"
        save chosenAttachment in (POSIX file destinationPath)
    end tell
end run
`;

type MailPage = { items: MailPdf[]; nextOffset: number; hasMore: boolean };

async function loadMailPdfs(offset: number, count: number): Promise<MailPage> {
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", listScript, "--", String(offset), String(count)], {
    timeout: 60000, maxBuffer: 5 * 1024 * 1024,
  });
  const records = stdout.trimEnd().split(RECORD);
  const [processedText, totalText] = (records.shift() ?? "").split(FIELD);
  const processed = Number(processedText);
  const total = Number(totalText);
  if (!Number.isSafeInteger(processed) || !Number.isSafeInteger(total) || processed < 0 || processed > count || total < 0) {
    throw new Error("Ungültige Seiteninformation von Apple Mail");
  }
  const items = records.filter(Boolean).map((line) => {
    const fields = line.split(FIELD);
    if (fields.length !== 8) throw new Error("Unerwartete Antwort von Apple Mail");
    const [account, mailbox, messageId, indexText, subject, sender, filename, received] = fields;
    const attachmentIndex = Number(indexText);
    if (!account || !mailbox || !/^\d+$/.test(messageId) || !Number.isSafeInteger(attachmentIndex) || attachmentIndex < 1)
      throw new Error("Ungültige Nachrichtenkennung");
    return {
      key: JSON.stringify([account, mailbox, messageId, attachmentIndex]),
      account, mailbox, messageId, attachmentIndex,
      subject: subject || "(Ohne Betreff)", sender, filename, received,
    };
  });
  const nextOffset = offset + processed;
  return { items, nextOffset, hasMore: nextOffset < total };
}

async function cleanupOldMailFiles() {
  const entries = await readdir(os.tmpdir(), { withFileTypes: true });
  const now = Date.now();

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^raycast-mail-[A-Za-z0-9_-]+$/.test(entry.name)) continue;
    const directory = path.join(os.tmpdir(), entry.name);

    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || now - info.mtimeMs <= 24 * 60 * 60 * 1000) continue;

      const files = await readdir(directory);
      if (files.length === 0) {
        await rmdir(directory);
        continue;
      }
      if (files.length !== 1 || !/^mail-[0-9a-f-]{36}\.pdf$/.test(files[0])) continue;

      const pdfPath = path.join(directory, files[0]);
      const pdfInfo = await lstat(pdfPath);
      if (!pdfInfo.isFile() || pdfInfo.isSymbolicLink()) continue;

      await rm(pdfPath);
      await rmdir(directory);
    } catch {
      // Geänderte, nicht mehr vorhandene oder nicht leere Verzeichnisse unangetastet lassen.
    }
  }
}

async function downloadMailPdf(item: MailPdf): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "raycast-mail-"));
  const target = path.join(directory, `mail-${randomUUID()}.pdf`);
  try {
    await execFileAsync("/usr/bin/osascript", ["-e", saveScript, "--", item.account, item.mailbox,
      item.messageId, String(item.attachmentIndex), item.filename, target], {
      timeout: 60000, maxBuffer: 1024 * 1024,
    });
    const fileInfo = await lstat(target);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error("Anhang ist keine reguläre Datei");
    if (fileInfo.size < 5 || fileInfo.size > MAX_PDF_BYTES) throw new Error("PDF ist leer oder größer als 30 MB");
    const file = await open(target, "r");
    let magic: string;
    try {
      const header = Buffer.alloc(5);
      const { bytesRead } = await file.read(header, 0, 5, 0);
      magic = bytesRead === 5 ? header.toString("ascii") : "";
    } finally {
      await file.close();
    }
    if (magic !== "%PDF-") throw new Error("Anhang enthält keine gültige PDF-Kennung");
    // Die Datei ist nur im privaten Temp-Verzeichnis verfügbar.
    return target;
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export default function MailCommand() {
  const { push } = useNavigation();
  const [items, setItems] = useState<MailPdf[]>([]);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  async function refresh() {
    if (loading && nextOffset !== 0) return;
    setLoading(true);
    try {
      void cleanupOldMailFiles().catch(() => {});
      const page = await loadMailPdfs(0, 30);
      setItems(page.items);
      setNextOffset(page.nextOffset);
      setHasMore(page.hasMore);
    } catch (error) {
      await showToast({ style: Toast.Style.Failure, title: "Apple Mail konnte nicht gelesen werden", message: String(error) });
    } finally { setLoading(false); }
  }

  async function loadMore() {
    if (loading || !hasMore) return;
    setLoading(true);
    try {
      const page = await loadMailPdfs(nextOffset, 100);
      setItems((previous) => {
        const seen = new Set(previous.map((item) => item.key));
        return [...previous, ...page.items.filter((item) => !seen.has(item.key))];
      });
      setNextOffset(page.nextOffset);
      setHasMore(page.hasMore);
    } catch (error) {
      await showToast({ style: Toast.Style.Failure, title: "Weitere E-Mails konnten nicht geladen werden", message: String(error) });
    } finally { setLoading(false); }
  }

  async function openPdf(item: MailPdf) {
    if (opening) return;
    setOpening(true);
    try {
      const filePath = await downloadMailPdf(item);
      push(<InvoiceForm sourceFilePath={filePath} sourceFilename={item.filename} deleteOnUnmount />);
    } catch (error) {
      await showToast({ style: Toast.Style.Failure, title: "Mail-PDF konnte nicht geöffnet werden", message: String(error) });
    } finally { setOpening(false); }
  }

  useEffect(() => { void refresh(); }, []);

  const actions = (item?: MailPdf) => (
    <ActionPanel>
      {item && <Action title="Rechnung aus PDF auslesen" icon={Icon.Document} onAction={() => openPdf(item)} />}
      {hasMore && <Action title="Weitere 100 E-Mails laden" icon={Icon.Plus} onAction={loadMore} />}
      <Action title="Liste aktualisieren" icon={Icon.ArrowClockwise} onAction={refresh} />
    </ActionPanel>
  );

  return (
    <List isLoading={loading || opening} searchBarPlaceholder="Geladene PDF-Anhänge durchsuchen…">
      {items.length === 0 && <List.EmptyView title="Noch keine PDFs gefunden" description={hasMore ? "Weitere E-Mails über die Aktionen laden." : "Keine PDF-Anhänge im geprüften Posteingang."} actions={actions()} />}
      {items.map((item) => (
        <List.Item
          key={item.key}
          icon={Icon.Document}
          title={item.filename}
          subtitle={item.subject}
          accessories={[{ text: item.sender }]}
          actions={actions(item)}
        />
      ))}
    </List>
  );
}
