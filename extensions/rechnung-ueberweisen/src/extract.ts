export type Candidate = { value: string; reason: string; score: number };
export type Invoice = { recipient: Candidate[]; iban: Candidate[]; amount: Candidate[]; purpose: Candidate[]; text: string; usedOCR: boolean; qrDetected?: boolean };
const normIban = (s: string) => s.replace(/[\s-]/g, "").toUpperCase();
function ibanValid(raw: string): boolean {
  const s = normIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  let mod = 0;
  for (const c of s.slice(4) + s.slice(0, 4)) {
    const digits = /[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c;
    for (const d of digits) mod = (mod * 10 + Number(d)) % 97;
  }
  return mod === 1;
}
function uniq(xs: Candidate[]): Candidate[] {
  const sorted = [...xs].sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  return sorted.filter((c) => { const k = c.value.trim().toLocaleLowerCase("de"); if (seen.has(k)) return false; seen.add(k); return true; });
}
function money(s: string): string | undefined {
  const clean = s.replace(/EUR/gi, "").replace(/[€\s]/g, "");
  let normalized: string;
  if (clean.includes(",")) normalized = clean.replace(/\./g, "").replace(",", ".");
  else normalized = clean;
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return undefined;
  const n = Number(normalized);
  return Number.isFinite(n) && n > 0 ? `${n.toFixed(2).replace(".", ",")} €` : undefined;
}
const candidate = (value: string, reason: string, score: number): Candidate => ({ value: value.trim(), reason, score });

// EPC QR / GiroCode (European Payments Council, BCD, SCT). Do not interpret unrelated QR codes.
export function parseEpcQr(payload: string): { recipient: string; iban: string; amount?: string; purpose?: string } | undefined {
  const rows = payload.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "").split("\n");
  if (rows[0]?.trim() !== "BCD" || !["001", "002"].includes(rows[1]?.trim()) || rows[3]?.trim() !== "SCT") return undefined;
  // EPC: 0 BCD, 1 version, 2 charset, 3 SCT, 4 BIC, 5 name, 6 IBAN, 7 amount, 8 purpose code, 9 remittance structured, 10 remittance unstructured.
  const recipient = (rows[5] ?? "").trim();
  const iban = normIban(rows[6] ?? "");
  if (!recipient || !ibanValid(iban)) return undefined;
  const rawAmount = (rows[7] ?? "").trim();
  const amount = /^EUR\d+(?:\.\d{1,2})?$/.test(rawAmount) ? money(rawAmount.slice(3)) : undefined;
  const purpose = (rows[10] ?? "").trim() || (rows[9] ?? "").trim() || undefined;
  return { recipient, iban, amount, purpose };
}

export function parseInvoice(text: string, qrCodes: string[] = []): Invoice {
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const recipients: Candidate[] = [], ibans: Candidate[] = [], amounts: Candidate[] = [], purposes: Candidate[] = [];
  const numberFields: Record<string, string> = {};
  // Currency marker required: prevents treating dates, IDs or percentages as amounts.
  // Supports "267,40 €", "267,40 EUR" and "EUR 267,40".
  const amountPattern = /(?:\bEUR\s*(?:\d{1,3}(?:\.\d{3})+|\d+)\s*,\s*\d{2}\b|\b(?:\d{1,3}(?:\.\d{3})+|\d+)\s*,\s*\d{2}\s*(?:€|EUR\b))/gi;
  const totalWords = /brutto\s*(?:summe|betrag)?|gesamt\s*(?:betrag|summe)|rechnungs\s*(?:betrag|summe)|end\s*(?:betrag|summe)|zahl\s*(?:betrag|bar)|zu\s*zahlen|überweisungsbetrag/i;
  const negativeWords = /netto|mehrwertsteuer|umsatzsteuer|\bmwst\b|\bust\b|teilsumme|einzelpreis|kundenpreis|alter\s+rechnungsbetrag|nicht\s+verwenden/i;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const nearby = lines.slice(Math.max(0, n - 1), Math.min(lines.length, n + 2)).join(" ");
    // Recognize IBANs separated by spaces/tabs; validate checksum before accepting.
    for (const m of line.toUpperCase().matchAll(/\b[A-Z]{2}\d{2}(?:[\s-]?[A-Z0-9]){11,32}\b/g)) {
      const raw = normIban(m[0]);
      if (ibanValid(raw)) ibans.push(candidate(raw.replace(/(.{4})/g, "$1 ").trim(), line.slice(0, 100), /IBAN/i.test(line) ? 105 : 65));
    }
    for (const m of line.matchAll(amountPattern)) {
      const value = money(m[0].replace(/\s+/g, ""));
      if (!value) continue;
      const prefix = line.slice(0, m.index).trim();
      let score = 40;
      // Negative qualifiers take precedence even if "Rechnungsbetrag" appears.
      if (negativeWords.test(line)) score = 5;
      else if (/\bzu\s*zahlen\b/i.test(prefix)) score = 180;
      else if (totalWords.test(prefix) || /\bbetrag\s*:\s*$/i.test(prefix)) score = 155;
      else if (totalWords.test(nearby) && !/portokosten|versandkosten|gebühr/i.test(line)) score = 90;
      amounts.push(candidate(value, line.slice(0, 120), score));
    }
    const explicit = line.match(/(?:verwendungs\s*zweck|zahlungs\s*referenz|verwendungs\s*text)\s*[:：]?\s+(.+)$/i);
    if (explicit) purposes.push(candidate(explicit[1], "Expliziter Verwendungszweck", 125));
    const field = line.match(/\b(rechnungs\s*(?:nummer|nr\.?|\-nr\.?)|beleg\s*(?:nummer|nr\.?)|kunden\s*(?:nummer|nr\.?|\-nr\.?))\s*[:：#]?\s*([A-Z0-9][A-Z0-9\-/.]*)\b/i);
    if (field) {
      const label = field[1].replace(/\s+/g, "").toLowerCase();
      const value = field[2];
      if (/^(?:rechnungs|beleg)/.test(label)) numberFields.invoice = value;
      if (/^kunden/.test(label)) numberFields.customer = value;
    }
    // Prefer names near the header or explicit account holder; do not infer the billed customer.
    const holder = line.match(/(?:kontoinhaber|zahlungsempfänger|begünstigter)\s*[:：]?\s+(.+)$/i);
    if (holder) recipients.push(candidate(holder[1], "Kontoinhaber / Zahlungsempfänger", 115));
    const firmNames = [...line.matchAll(/([\p{L}][\p{L}\d&.,'\- ]{1,75}?\s+(?:GmbH(?:\s*&\s*Co\.?\s*KG)?|AG|UG|e\.?K\.?|GbR|KG|OHG))\b/gu)];
    for (const f of firmNames) {
      const name = f[1].replace(/^.*?\|\s*/, "").trim();
      if (/\s{3,}|\b(?:str\.|straße|strasse|alzey)\b/i.test(name)) continue;
      recipients.push(candidate(name, n < 10 ? "Firmenname im Briefkopf" : "Firmenname im Dokument", n < 10 ? 85 : 55));
    }
    // Hyphenated business names, e.g. Nibelungen-Apotheke.
    if (n < 12) {
      const apotheke = line.match(/\b([\p{L}][\p{L}\- ]{2,60}[- ]Apotheke)\b/iu);
      if (apotheke) recipients.push(candidate(apotheke[1], "Apothekenname im Briefkopf", 80));
    }
  }
  if (numberFields.invoice && numberFields.customer) {
    purposes.push(candidate(`Rechnung ${numberFields.invoice}, Kundennr. ${numberFields.customer}`, "Beleg-/Rechnungsnummer und Kundennummer", 100));
  } else if (numberFields.invoice) purposes.push(candidate(`Rechnung ${numberFields.invoice}`, "Rechnungs-/Belegnummer", 70));
  else if (numberFields.customer) purposes.push(candidate(`Kundennr. ${numberFields.customer}`, "Kundennummer", 45));

  let qrDetected = false;
  for (const payload of qrCodes) {
    const qr = parseEpcQr(payload);
    if (!qr) continue;
    qrDetected = true;
    recipients.push(candidate(qr.recipient, "SEPA-QR-Code (Kontoinhaber)", 300));
    ibans.push(candidate(qr.iban.replace(/(.{4})/g, "$1 ").trim(), "SEPA-QR-Code", 300));
    if (qr.amount) amounts.push(candidate(qr.amount, "SEPA-QR-Code (Überweisungsbetrag)", 300));
    if (qr.purpose) purposes.push(candidate(qr.purpose, "SEPA-QR-Code (Verwendungszweck)", 300));
    break;
  }
  return { recipient: uniq(recipients).slice(0, 8), iban: uniq(ibans).slice(0, 8), amount: uniq(amounts).slice(0, 8), purpose: uniq(purposes).slice(0, 8), text, usedOCR: false, qrDetected };
}
