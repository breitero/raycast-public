# Raycast Extensions

Open-source Raycast extensions for macOS.

## Extensions

### Rechnung überweisen (Invoice to Bank Transfer)

A Raycast extension that extracts payment details from PDF invoices and prepares **SEPA transfer drafts** for simplebanking / simplesend. It **does not submit or authorize payments**.

**Three ways to open an invoice:**

- **Finder:** Analyze a PDF selected in Finder.
- **Paperless-ngx:** Search invoices in a self-hosted Paperless-ngx instance and process a selected document.
- **Apple Mail (new in v0.8.0):** Find PDF attachments in the combined inbox, select a specific attachment, and load older messages in batches.

**Extraction features:** SEPA/EPC payment QR codes, PDF text and OCR, password-protected PDFs with optional macOS Keychain support, editable payment details, and an atomic local JSON draft handoff to simplebanking / simplesend.

The Raycast interface is currently in German. The extension is intended for local use on macOS.

[Source code and detailed setup instructions](extensions/rechnung-ueberweisen/README.md)

## Requirements

- macOS and Raycast
- Node.js and npm for building from source
- Swift / Xcode Command Line Tools for PDF extraction
- simplebanking with working simplesend support for transfer-draft handoff
- Optional: Paperless-ngx for the Paperless command; Apple Mail for the Mail command

## Security

Always verify the payee, IBAN, amount, payment reference, and debit account in simplebanking before authorizing a transfer. Do not include real invoices or credentials in public bug reports.

## License

MIT License. See [LICENSE](LICENSE).
