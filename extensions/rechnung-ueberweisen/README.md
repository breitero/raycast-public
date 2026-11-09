# Rechnung überweisen — Raycast extension

A macOS Raycast extension that extracts payment details from PDF invoices selected in **Finder**, retrieved from **Paperless-ngx**, or selected as attachments in **Apple Mail**. It prepares a **prefilled SEPA transfer draft in simplebanking / simplesend**. It does **not** submit or authorize payments.

> **Language:** The Raycast interface is currently in German. This README is in English for contributors.

## What's new in v0.8.0

- **Apple Mail integration:** Browse PDF attachments from the combined inbox across configured Mail accounts, with one entry per PDF attachment.
- **Faster initial Mail listing:** Scan the latest 30 messages first; load 100 more messages on demand. Actual speed depends on the mailbox and device.
- **Precise attachment selection:** Identify the account, mailbox, message, and attachment position; re-check the attachment filename before saving.
- **Safer local processing:** Validate temporary PDF files and remove extension-created temporary files after processing, with cleanup of older interrupted downloads.
- **Improved amount recognition:** Recognize common EUR formats such as `267,40 €`, `267,40 EUR`, and `EUR 267,40`; prioritize payment totals over incidental amounts.
- **Regression-tested workflows:** Finder, Paperless-ngx, and Apple Mail all use the same editable invoice review form.

Version 0.7.0 introduced optional Paperless-ngx integration. The Finder workflow remains available without either optional integration.

## Features

- Read a selected PDF directly from Finder.
- Search invoices in a self-hosted Paperless-ngx instance (optional).
- Browse PDF attachments in Apple Mail's combined inbox (optional); load older messages on demand.
- Prioritize valid SEPA/EPC payment QR codes when available.
- Fall back to PDF text extraction and OCR, with heuristics for payee, checksum-validated IBAN, amount, and payment reference.
- Review and edit the four payment fields and choose detected alternatives.
- Unlock password-protected PDFs using Apple's PDFKit. Optionally save a successfully used password in **macOS Keychain** for reuse.
- Send an atomic local JSON transfer draft to simplebanking / simplesend, without clipboard-based handoff.
- Launch simplebanking only when necessary, avoiding an unnecessary reopen event when it is already running.
- Copy payment details to the clipboard as an alternative.

## Requirements

- macOS and [Raycast](https://www.raycast.com/)
- Node.js and npm to build the extension
- Swift / Xcode Command Line Tools for the local PDF helper
- [simplebanking](https://github.com/klotzbrocken/simplebanking) with working simplesend support and permission to accept external transfer drafts
- **Optional:** Apple Mail, configured with at least one mail account, for the Mail command
- **Optional:** Paperless-ngx and an API token for the Paperless command

## Installation

From the repository root:

```bash
cd extensions/rechnung-ueberweisen
npm install
npm run dev
```

For a production build, run `npm run build`. Configure optional command preferences in Raycast and assign keyboard shortcuts if desired.

In simplebanking, enable the setting for accepting external transfer drafts. Depending on the installed version, the preference may also be enabled with:

```bash
defaults write tech.yaxi.simplebanking mcpDraftsEnabled -bool true
```

Restart simplebanking after changing this preference. A working simplesend entitlement is required.

## Usage: Finder

1. Select a PDF invoice in Finder.
2. Run **Rechnung überweisen** in Raycast.
3. If prompted, unlock the PDF with its password.
4. Review **Empfänger** (payee), **IBAN**, **Betrag** (amount), and **Verwendungszweck** (payment reference); edit values or choose alternatives as needed.
5. Optionally choose **In simplesend öffnen** to create a transfer draft.
6. Select the debit account, verify all details, and explicitly authorize the transfer **in simplebanking**.

The extension **never executes a bank transfer by itself**.

## Usage: Apple Mail

1. Configure an account in Apple's **Mail** application and allow the macOS automation permission when prompted.
2. Run **Rechnung aus Mail** in Raycast.
3. The command initially scans the **latest 30 messages** in the combined inbox across Mail accounts and lists PDF attachments individually. Use **Weitere 100 E-Mails laden** to scan older messages in batches.
4. Select the desired PDF. The command re-locates the message by account, mailbox, and message ID, then checks the attachment position and filename before saving a temporary copy.
5. Review and, if necessary, correct the extracted payment details.
6. Optionally send a draft to simplesend; final authorization takes place in simplebanking.

The search in Raycast filters **already loaded** PDF results; it does not search the entire Mail archive. The command currently targets the combined inbox, not arbitrary Mail folders. Loading speed depends on mailbox size and macOS automation performance.

Attachments are copied to temporary local files for processing; original Mail messages and attachments are not intentionally modified. The implementation does not deliberately mark messages as read, delete them, or send mail. Temporary copies are cleaned up after processing, with an additional cleanup mechanism for older interrupted sessions. Password-protected PDFs may need to remain temporarily available until unlocking completes.

## Paperless-ngx setup and usage

Paperless-ngx integration is optional and independent of other Raycast Paperless extensions.

1. Configure **Paperless-ngx Server URL** and **Paperless-ngx API Token** in the preferences for **Rechnung aus Paperless**.
2. Classify invoices in Paperless-ngx using the document type `Rechnung`.
3. Run **Rechnung aus Paperless** in Raycast.
4. Search for and select an invoice.
5. Review and edit the extracted payee, IBAN, amount, and payment reference.
6. Optionally choose **In simplesend öffnen** to prepare the transfer; verify and authorize it in simplebanking.

The document type is resolved dynamically through the Paperless-ngx API; no document type ID needs to be configured. Downloaded PDFs are processed locally as temporary files and cleaned up after processing, with cleanup of older files from interrupted sessions. Original Paperless documents are not modified.

Paperless credentials are configured in Raycast preferences, not embedded in the source code. The API token uses a password-type preference.

## Password-protected PDFs

The PDF is unlocked for reading without modifying the original file. A password can be stored in the macOS Keychain and reused automatically. The saved password is tried for **other encrypted PDFs as well**; it is not currently restricted to a particular sender. If it does not work, Raycast prompts for another password. Passwords are not placed in transfer-draft JSON or the source repository.

Each Mac must have access to the relevant Keychain entry; cloning the repository alone does not transfer passwords.

## How the handoff works

The extension creates an atomic JSON draft in:

```text
~/Library/Application Support/simplebanking/transfer-drafts/
```

The draft contains the payee name, validated IBAN, EUR amount, payment reference, creation time, and short expiration time. The simplebanking filesystem watcher detects the draft and opens simplesend. When simplebanking is already running, the extension does **not** call `open -a` again. Otherwise, it launches the app.

Depending on the installed simplebanking version, launching a stopped app may also show its main window.

## Project layout

```text
rechnung-ueberweisen/
├── assets/
│   ├── extract.swift                 # PDFKit, Vision, PDF unlocking, Keychain
│   ├── command-icon.png
│   └── transfer-icon.png
├── src/
│   ├── extract.ts                    # Payment-data parsing and candidate ranking
│   ├── rechnung-ueberweisen.tsx      # Invoice form and simplesend handoff
│   ├── rechnung-aus-paperless.tsx    # Paperless-ngx search and download
│   └── rechnung-aus-mail.tsx         # Apple Mail PDF selection and download
├── package.json
├── package-lock.json
├── raycast-env.d.ts
└── tsconfig.json
```

## Limitations and safety

- PDF extraction is heuristic. Always verify the payee, IBAN, amount, and payment reference before authorizing a payment.
- The debit account is selected inside simplesend, not by this extension.
- Mail listing initially scans only recent inbox messages; older messages require explicit loading.
- An attachment's PDF filename alone is not treated as a unique identifier.
- The extension is a local convenience tool, not a payment service or a substitute for bank verification.
- The current UI is German-only.

## Contributing

Issues and pull requests are welcome. Please do not include real invoices, personal banking data, credentials, or unredacted screenshots in public reports.

## License

MIT — see the repository's root `LICENSE` file.
