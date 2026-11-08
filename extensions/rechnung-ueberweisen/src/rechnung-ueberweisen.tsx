import { Action, ActionPanel, Clipboard, environment, Form, getSelectedFinderItems, Icon, showToast, Toast } from "@raycast/api";
import { useEffect, useState } from "react";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { parseInvoice, type Invoice, type Candidate } from "./extract";

const execFileAsync = promisify(execFile);
const swiftScript = path.join(environment.assetsPath, "extract.swift");
const best = (items: Candidate[]) => items[0]?.value ?? "";
const draftsDirectory = path.join(os.homedir(), "Library", "Application Support", "simplebanking", "transfer-drafts");

function normalizeAmount(input: string): string | undefined {
  const value = input.replace(/\s/g, "").replace(/€/g, "").replace(/EUR/gi, "");
  if (!/^[0-9.,]+$/.test(value)) return undefined;
  const lastComma = value.lastIndexOf(",");
  const lastDot = value.lastIndexOf(".");
  let normalized: string;
  if (lastComma > lastDot) {
    normalized = value.replace(/\./g, "").replace(",", ".");
  } else if (lastDot > lastComma) {
    normalized = value.replace(/,/g, "");
  } else {
    normalized = value;
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return undefined;
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  return amount.toFixed(2);
}

function normalizeIban(input: string): string | undefined {
  const value = input.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(value)) return undefined;
  const rearranged = value.slice(4) + value.slice(0, 4);
  let remainder = 0;
  for (const character of rearranged) {
    const digits = /[A-Z]/.test(character) ? String(character.charCodeAt(0) - 55) : character;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1 ? value : undefined;
}

/** Alternativen bleiben im Formular: kein Push/Pop und damit kein Navigations-Fokusverlust. */
function AlternativePicker({
  title,
  candidates,
  selected,
  onSelect,
}: {
  title: string;
  candidates: Candidate[];
  selected: string;
  onSelect: (value: string) => void;
}) {
  const values = Array.from(new Set(candidates.map((candidate) => candidate.value).filter(Boolean)));
  if (values.length < 2) return null;
  return (
    <Form.Dropdown
      id={`alternative-${title}`}
      title={`${title}: Alternative`}
      value={values.includes(selected) ? selected : "__custom__"}
      onChange={(value) => {
        if (value !== "__custom__") onSelect(value);
      }}
      info="Wähle einen erkannten Wert. Das Textfeld darüber bleibt frei bearbeitbar."
    >
      {!values.includes(selected) && <Form.Dropdown.Item value="__custom__" title="Manuell bearbeiteter Wert" />}
      {values.map((value) => (
        <Form.Dropdown.Item key={value} value={value} title={value} />
      ))}
    </Form.Dropdown>
  );
}

export function InvoiceForm({ sourceFilePath, sourceFilename, deleteOnUnmount = false }: {
  sourceFilePath?: string;
  sourceFilename?: string;
  deleteOnUnmount?: boolean;
}) {
  const [invoice, setInvoice] = useState<Invoice>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [filename, setFilename] = useState("");
  const [recipient, setRecipient] = useState("");
  const [iban, setIban] = useState("");
  const [amount, setAmount] = useState("");
  const [purpose, setPurpose] = useState("");
  const [pdfPath, setPdfPath] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [pdfPassword, setPdfPassword] = useState("");
  const [savePassword, setSavePassword] = useState(true);
  const [passwordRejected, setPasswordRejected] = useState(false);

  // Nur von dieser Extension erzeugte Paperless-Tempdateien löschen.
  // Niemals Finder-PDFs anfassen. Nicht beim Unmount löschen: Raycast kann
  // während eines laufenden Swift-Aufrufs die View kurz neu aufbauen.
  async function cleanupPaperlessPdf(filePath: string) {
    if (!deleteOnUnmount || !sourceFilePath || filePath !== sourceFilePath) return;
    const directory = path.dirname(filePath);
    if (path.dirname(directory) !== os.tmpdir() ||
        !path.basename(directory).startsWith("raycast-paperless-") ||
        !/^paperless-\d+\.pdf$/.test(path.basename(filePath))) return;
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }

  async function extractPdf(filePath: string, password?: string, remember = false) {
    setLoading(true);
    try {
      if (!existsSync(swiftScript)) throw new Error(`Swift-Datei fehlt in den Raycast-Assets: ${swiftScript}`);
      // Das Passwort wird über stdin übertragen, nicht über Kommandozeilenargumente.
      const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
        const child = execFile("/usr/bin/swift", [swiftScript, filePath],
          { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
            if (error) reject(error); else resolve({ stdout });
          });
        child.stdin?.on("error", () => {});
        child.stdin?.end(JSON.stringify({ password: password || null, savePassword: remember }));
      });
      const extracted = JSON.parse(stdout) as {
        text: string; usedOCR: boolean; qrCodes?: string[];
        needsPassword?: boolean; passwordRejected?: boolean;
      };
      if (extracted.needsPassword) {
        setNeedsPassword(true);
        setPasswordRejected(Boolean(extracted.passwordRejected));
        return;
      }
      const data: Invoice = { ...parseInvoice(extracted.text, extracted.qrCodes ?? []), usedOCR: extracted.usedOCR };
      setInvoice(data);
      setRecipient(best(data.recipient));
      setIban(best(data.iban));
      setAmount(best(data.amount));
      setPurpose(best(data.purpose));
      setNeedsPassword(false);
      setPasswordRejected(false);
      setPdfPassword("");
      // PDF wird nach erfolgreicher Swift-Auswertung nicht mehr benötigt.
      // Bei Passwortabfrage bleibt sie bis zum erfolgreichen Entsperren erhalten.
      await cleanupPaperlessPdf(filePath);
      if (!data.iban.length) await showToast({ style: Toast.Style.Failure, title: "Keine gültige IBAN erkannt", message: "Bitte manuell ergänzen." });
    } catch (error) {
      await cleanupPaperlessPdf(filePath);
      await showToast({ style: Toast.Style.Failure, title: "PDF konnte nicht verarbeitet werden", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        let pdfPathToRead = sourceFilePath;
        if (!pdfPathToRead) {
          const selected = await getSelectedFinderItems();
          pdfPathToRead = selected.find((item) => item.path.toLowerCase().endsWith(".pdf"))?.path;
        }
        if (!pdfPathToRead) throw new Error("Bitte zuerst eine PDF-Datei im Finder markieren.");
        if (!active) return;
        setPdfPath(pdfPathToRead);
        setFilename(sourceFilename || path.basename(pdfPathToRead));
        await extractPdf(pdfPathToRead);
      } catch (error) {
        if (active) {
          setLoading(false);
          await showToast({ style: Toast.Style.Failure, title: "PDF konnte nicht verarbeitet werden", message: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    void load();
    return () => {
      active = false;
      // Kein Unmount-Cleanup: könnte laufenden Swift-Aufruf unterbrechen.
    };
  }, [sourceFilePath, sourceFilename, deleteOnUnmount]);

  function paymentText(): string {
    return [
      `Empfänger: ${recipient.trim()}`,
      `IBAN: ${iban.trim()}`,
      `Betrag: ${amount.trim()}`,
      `Verwendungszweck: ${purpose.trim()}`,
    ].join("\n");
  }

  async function copyPayment() {
    await Clipboard.copy(paymentText());
    await showToast({ style: Toast.Style.Success, title: "Zahlungsdaten kopiert" });
  }

  async function sendDraft() {
    if (submitting) return;
    const name = recipient.trim();
    const validIban = normalizeIban(iban);
    const validAmount = normalizeAmount(amount);
    if (!name) {
      await showToast({ style: Toast.Style.Failure, title: "Empfänger fehlt" });
      return;
    }
    if (!validIban) {
      await showToast({ style: Toast.Style.Failure, title: "Ungültige IBAN", message: "Bitte die IBAN prüfen." });
      return;
    }
    if (!validAmount) {
      await showToast({ style: Toast.Style.Failure, title: "Ungültiger Betrag", message: "Bitte einen positiven Euro-Betrag eingeben." });
      return;
    }
    setSubmitting(true);
    try {
      // Nur starten, wenn simplebanking nicht bereits läuft. Ein erneutes `open -a`
      // löst sonst ein Reopen-Ereignis aus und öffnet zusätzlich die Umsatzliste.
      let appIsRunning = false;
      try {
        await execFileAsync("/usr/bin/pgrep", ["-x", "simplebanking"], { timeout: 5000 });
        appIsRunning = true;
      } catch (error) {
        // pgrep: Exit-Code 1 = kein passender Prozess; andere Fehler nicht verschlucken.
        const exitCode = (error as NodeJS.ErrnoException & { code?: number | string }).code;
        if (exitCode !== 1) throw error;
      }
      if (!appIsRunning) {
        await execFileAsync("/usr/bin/open", ["-g", "-a", "simplebanking"], { timeout: 10000 });
      }
      await mkdir(draftsDirectory, { recursive: true });
      const id = randomUUID().toUpperCase();
      const now = Date.now();
      const draft = {
        id,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 5 * 60 * 1000).toISOString(),
        source: "cli",
        creditorName: name,
        creditorIban: validIban,
        amountEUR: validAmount,
        remittance: purpose.trim() || null,
        endToEndId: null,
      };
      // Atomar veröffentlichen, damit simplebanking keine halbfertige JSON-Datei liest.
      const temporaryFile = path.join(draftsDirectory, `.${id}.tmp`);
      const destinationFile = path.join(draftsDirectory, `${id}.json`);
      await writeFile(temporaryFile, JSON.stringify(draft, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporaryFile, destinationFile);
      await showToast({
        style: Toast.Style.Success,
        title: "Überweisungsentwurf übergeben",
        message: "simplesend sollte sich öffnen. Absenderkonto und alle Daten vor Freigabe prüfen.",
      });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Übergabe an simplebanking fehlgeschlagen",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Form
      isLoading={loading || submitting}
      actions={
        <ActionPanel>
          {needsPassword ? (
            <Action title="PDF entsperren und auslesen" icon={Icon.LockUnlocked} onAction={() => extractPdf(pdfPath, pdfPassword, savePassword)} />
          ) : (
            <Action title="In simplesend öffnen" icon={Icon.ArrowRight} onAction={sendDraft} />
          )}
          <Action title="Nur Zahlungsdaten kopieren" icon={Icon.CopyClipboard} onAction={copyPayment} />
          <ActionPanel.Section>
            <Action title="Erkannten PDF-Text kopieren" icon={Icon.Document} onAction={() => Clipboard.copy(invoice?.text ?? "")} />
          </ActionPanel.Section>
        </ActionPanel>
      }
    >
      <Form.Description title="Rechnung" text={`${filename || "PDF im Finder markieren"}${invoice?.qrDetected ? " · SEPA-QR-Code erkannt" : ""}`} />
      {needsPassword && (
        <>
          <Form.Description text={passwordRejected ? "Passwort nicht korrekt. Bitte erneut eingeben." : "Dieses PDF ist passwortgeschützt. Bitte Passwort eingeben."} />
          <Form.PasswordField id="pdfPassword" title="PDF-Passwort" value={pdfPassword} onChange={setPdfPassword} />
          <Form.Checkbox id="rememberPassword" label="Passwort im macOS-Schlüsselbund speichern (für weitere geschützte PDFs)" value={savePassword} onChange={setSavePassword} />
        </>
      )}
      {!needsPassword && <>
      <Form.TextField id="recipient" title="Empfänger" value={recipient} onChange={setRecipient} placeholder="Zahlungsempfänger" />
      <AlternativePicker title="Empfänger" candidates={invoice?.recipient ?? []} selected={recipient} onSelect={setRecipient} />
      <Form.TextField id="iban" title="IBAN" value={iban} onChange={setIban} placeholder="DE…" />
      <AlternativePicker title="IBAN" candidates={invoice?.iban ?? []} selected={iban} onSelect={setIban} />
      <Form.TextField id="amount" title="Betrag" value={amount} onChange={setAmount} placeholder="0,00 €" />
      <AlternativePicker title="Betrag" candidates={invoice?.amount ?? []} selected={amount} onSelect={setAmount} />
      <Form.TextField id="purpose" title="Verwendungszweck" value={purpose} onChange={setPurpose} />
      <AlternativePicker title="Verwendungszweck" candidates={invoice?.purpose ?? []} selected={purpose} onSelect={setPurpose} />
      <Form.Description text="Alternativen bei Bedarf direkt unter dem jeweiligen Feld auswählen · JSON-Übergabe ohne Zwischenablage. Absenderkonto und Angaben in simplesend prüfen." />
      </>}
    </Form>
  );
}

export default function Command() {
  return <InvoiceForm />;
}
