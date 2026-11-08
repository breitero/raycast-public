import { Action, ActionPanel, Icon, List, getPreferenceValues, openCommandPreferences, showToast, Toast, useNavigation } from "@raycast/api";
import { useEffect, useState } from "react";
import { mkdtemp, rm, writeFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InvoiceForm } from "./rechnung-ueberweisen";

type Settings = { paperlessUrl?: string; paperlessToken?: string };
type Document = { id: number; title: string; created?: string; added?: string; correspondent?: number | null; original_file_name?: string };
type Page = { results: Document[]; next: string | null };
const MAX_PDF_BYTES = 30 * 1024 * 1024;

function config(): { base: URL; token: string } {
  const prefs = getPreferenceValues<Settings>();
  const url = (prefs.paperlessUrl ?? "").trim().replace(/\/+$/, "");
  const token = (prefs.paperlessToken ?? "").trim();
  if (!url || !token) throw new Error("Paperless-Server und API-Token in den Befehlseinstellungen hinterlegen.");
  const base = new URL(url + "/");
  if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error("Nur HTTP(S)-Serveradressen sind erlaubt.");
  if (base.username || base.password || base.search || base.hash) throw new Error("Bitte eine Serveradresse ohne Zugangsdaten, Query oder Fragment verwenden.");
  return { base, token };
}

async function apiGet(url: URL, base: URL, token: string, signal?: AbortSignal): Promise<Response> {
  // Keine Token-Weitergabe an fremde Hosts, auch nicht bei Redirects.
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname.replace(/\/?$/, "/") + "api/")) {
    throw new Error("Ungültige Paperless-API-Adresse.");
  }
  const response = await fetch(url, {
    headers: { Authorization: `Token ${token}`, Accept: "application/json, application/pdf, */*" },
    redirect: "manual",
    signal,
  });
  if (response.status >= 300 && response.status < 400) throw new Error("Paperless hat auf eine andere Adresse umgeleitet. Bitte die Server-URL prüfen.");
  if (response.status === 401 || response.status === 403) throw new Error("Paperless-Zugriff verweigert. Bitte API-Token und Berechtigungen prüfen.");
  if (!response.ok) throw new Error(`Paperless HTTP ${response.status}`);
  return response;
}

function apiUrl(base: URL, endpoint: string): URL {
  return new URL("api/" + endpoint, base);
}

type DocumentType = { id: number; name: string };
type DocumentTypePage = { results: DocumentType[]; next: string | null };

async function findInvoiceDocumentType(base: URL, token: string, signal: AbortSignal): Promise<number> {
  let next: URL | null = apiUrl(base, "document_types/");
  const visited = new Set<string>();
  while (next) {
    if (visited.has(next.href)) throw new Error("Paperless liefert eine zyklische Dokumenttyp-Paginierung.");
    visited.add(next.href);
    const response = await apiGet(next, base, token, signal);
    const data = (await response.json()) as DocumentTypePage;
    if (!Array.isArray(data.results)) throw new Error("Unerwartete Antwort beim Laden der Dokumenttypen.");
    const match = data.results.find((type) => type.name?.trim().toLocaleLowerCase("de") === "rechnung");
    if (match) return match.id;
    next = data.next ? new URL(data.next, base) : null;
  }
  throw new Error('In Paperless ist kein Dokumenttyp mit dem Namen "Rechnung" vorhanden.');
}

async function fetchDocuments(query: string, next: string | null, signal: AbortSignal): Promise<Page> {
  const { base, token } = config();
  const invoiceTypeId = await findInvoiceDocumentType(base, token, signal);
  const url = next ? new URL(next, base) : apiUrl(base, "documents/");
  url.searchParams.set("document_type__id", String(invoiceTypeId));
  if (!next) {
    url.searchParams.set("page_size", "30");
    url.searchParams.set("ordering", "-added");
    if (query.trim()) url.searchParams.set("text", query.trim());
  }
  const response = await apiGet(url, base, token, signal);
  const data = (await response.json()) as Page;
  if (!Array.isArray(data.results)) throw new Error("Unerwartete Antwort von Paperless.");
  return { results: data.results, next: data.next ?? null };
}

// Verwaiste PDFs (z.B. bei abgebrochener Passwortabfrage) nach 24h entfernen.
// Nur eigene Tempverzeichnisse im OS-Tempordner; keine fremden Dateien.
async function cleanupOldPaperlessFiles() {
  const tmp = os.tmpdir();
  const now = Date.now();
  try {
    for (const name of await readdir(tmp)) {
      if (!/^raycast-paperless-[A-Za-z0-9]+$/.test(name)) continue;
      const dir = path.join(tmp, name);
      try {
        const info = await stat(dir);
        if (info.isDirectory() && now - info.mtimeMs > 24 * 60 * 60 * 1000) {
          await rm(dir, { recursive: true, force: true });
        }
      } catch { /* bereits entfernt oder kein Zugriff */ }
    }
  } catch { /* Tempverzeichnis nicht lesbar */ }
}

async function downloadPdf(id: number): Promise<string> {
  const { base, token } = config();
  await cleanupOldPaperlessFiles();
  // Zuerst das Original für SEPA-QR-Codes; bei Nicht-PDF Archivversion versuchen.
  for (const original of [true, false]) {
    const url = apiUrl(base, `documents/${id}/download/`);
    if (original) url.searchParams.set("original", "true");
    const response = await apiGet(url, base, token);
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_PDF_BYTES) throw new Error("PDF ist größer als 30 MB.");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_PDF_BYTES) throw new Error("PDF ist größer als 30 MB.");
    if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") continue;
    const dir = await mkdtemp(path.join(os.tmpdir(), "raycast-paperless-"));
    const target = path.join(dir, `paperless-${id}.pdf`);
    try {
      await writeFile(target, buffer, { mode: 0o600 });
      return target;
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }
  throw new Error("Weder Original noch Archivversion ist ein PDF.");
}

export default function PaperlessCommand() {
  const { push } = useNavigation();
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<Document[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const page = await fetchDocuments(search, null, controller.signal);
        if (!controller.signal.aborted) { setItems(page.results); setNext(page.next); }
      } catch (e) {
        if (!controller.signal.aborted) { setItems([]); setNext(null); setError(e instanceof Error ? e.message : String(e)); }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [search, reload]);

  async function loadMore() {
    if (!next || loading) return;
    setLoading(true);
    try {
      const page = await fetchDocuments(search, next, new AbortController().signal);
      setItems((previous) => [...previous, ...page.results.filter((d) => !previous.some((p) => p.id === d.id))]);
      setNext(page.next);
    } catch (e) {
      await showToast({ style: Toast.Style.Failure, title: "Weitere Dokumente konnten nicht geladen werden", message: String(e) });
    } finally { setLoading(false); }
  }

  async function choose(doc: Document) {
    if (downloading) return;
    setDownloading(true);
    try {
      const pdf = await downloadPdf(doc.id);
      push(<InvoiceForm sourceFilePath={pdf} sourceFilename={doc.title || `Paperless #${doc.id}`} deleteOnUnmount />);
    } catch (e) {
      await showToast({ style: Toast.Style.Failure, title: "Dokument konnte nicht geladen werden", message: e instanceof Error ? e.message : String(e) });
    } finally { setDownloading(false); }
  }

  return (
    <List isLoading={loading || downloading} searchBarPlaceholder="Rechnungen in Paperless suchen…" onSearchTextChange={setSearch} throttle>
      {error ? (
        <List.EmptyView title="Paperless nicht erreichbar" description={error} actions={<ActionPanel><Action title="Paperless-Einstellungen öffnen" icon={Icon.Gear} onAction={openCommandPreferences} /><Action title="Erneut versuchen" onAction={() => setReload((v) => v + 1)} /></ActionPanel>} />
      ) : items.length === 0 ? (
        <List.EmptyView title="Keine Rechnungen gefunden" description="Nur Dokumente vom Typ Rechnung werden angezeigt. Suchbegriff ändern oder Suche leeren." />
      ) : (
        <>
          {items.map((doc) => (
            <List.Item
              key={doc.id}
              icon={Icon.Document}
              title={doc.title || `Dokument #${doc.id}`}
              subtitle={doc.original_file_name || undefined}
              accessories={[{ text: (doc.created || doc.added || "").slice(0, 10) }, { text: `#${doc.id}` }]}
              actions={<ActionPanel><Action title="Als Rechnung übernehmen" icon={Icon.ArrowRight} onAction={() => choose(doc)} /><Action title="Paperless-Einstellungen" icon={Icon.Gear} onAction={openCommandPreferences} /></ActionPanel>}
            />
          ))}
          {next && <List.Item title="Weitere Dokumente laden…" icon={Icon.ArrowDown} actions={<ActionPanel><Action title="Weitere Dokumente laden" onAction={loadMore} /></ActionPanel>} />}
        </>
      )}
    </List>
  );
}
