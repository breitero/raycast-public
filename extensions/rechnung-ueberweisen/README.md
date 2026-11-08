# Rechnung überweisen — Raycast extension

A macOS Raycast extension that reads payment details from PDF invoices selected in Finder or retrieved from **Paperless-ngx**, and prepares a **prefilled SEPA transfer in simplebanking / simplesend**. It does not submit or authorize payments.

> **Language:** The Raycast interface is currently in German. This README is in English for contributors.

## What's New in v0.7.0

Version 0.7.0 adds optional **Paperless-ngx integration**.

- Search invoices stored in your self-hosted Paperless-ngx instance directly from Raycast.
- Automatically filter documents by the Paperless document type `Rechnung`.
- Configure the Paperless server URL and API token in Raycast preferences.
- Download selected PDFs temporarily and process them using the existing invoice extraction workflow.
- Review and edit the extracted payment details before sending them to simplesend.
- Clean up temporary PDF files after processing, with additional cleanup for older files.
- Updated extension icon.

The original Finder-based workflow remains available without Paperless-ngx.

## Features

- Reads a selected PDF directly from Finder.
- Prioritizes SEPA/EPC payment QR codes when available.
- Falls back to PDF text extraction and OCR, with heuristics for payee, IBAN, gross amount, and payment reference.
- Lets you review and edit the four payment fields, including choosing detected alternatives.
- Supports password-protected PDFs using Apple's PDFKit. Optionally saves a successfully used password in **macOS Keychain** for later use.
- Sends a prefilled transfer draft to simplebanking's `simplesend` interface using a local JSON handoff. No clipboard paste is required.
- Checks whether simplebanking is running before launching it, avoiding an unnecessary application reopen and its additional transactions window.
- Offers a copy-to-clipboard fallback.

## Requirements

- macOS and [Raycast](https://www.raycast.com/)
- Node.js and npm to build the extension
- Swift / Xcode Command Line Tools for the local PDF helper
- [simplebanking](https://github.com/klotzbrocken/simplebanking) with working simplesend support and permission to accept external transfer drafts

## Installation

From the repository root:

```bash
cd extensions/rechnung-ueberweisen
npm install
npm run dev
```

For a production build, use `npm run build`. Configure the extension in Raycast and optionally assign a keyboard shortcut.

In simplebanking, enable the setting for accepting external transfer drafts. Depending on the installed version, the preference may also be enabled with:

```bash
defaults write tech.yaxi.simplebanking mcpDraftsEnabled -bool true
```

Restart simplebanking after changing this preference. A working simplesend entitlement is required.

## Usage

1. Select a PDF invoice in Finder.
2. Run **Rechnung überweisen** in Raycast.
3. If the PDF is encrypted, enter its password. You can choose to remember the password in macOS Keychain.
4. Review **Empfänger** (payee), **IBAN**, **Betrag** (amount), and **Verwendungszweck** (payment reference). Edit values or choose detected alternatives if needed.
5. Choose **In simplesend öffnen**. The extension writes a transfer draft and simplebanking opens the prefilled transfer interface.
6. Select the debit account, verify all details, and explicitly approve the transfer in simplebanking.

The extension **never executes a bank transfer by itself**.

## Paperless-ngx setup and usage

Paperless-ngx integration is optional and independent of other Raycast Paperless extensions.

1. Configure the **Paperless-ngx Server URL** and **Paperless-ngx API Token** in the preferences for the **Rechnung aus Paperless** command.
2. In Paperless-ngx, classify invoices using the document type `Rechnung`.
3. Run **Rechnung aus Paperless** in Raycast.
4. Search for and select an invoice.
5. Review the extracted payee, IBAN, amount, and payment reference.
6. Choose **In simplesend öffnen** to prepare the transfer in simplebanking.
7. Verify and authorize the transfer in simplebanking.

The document type is resolved dynamically through the Paperless-ngx API; no document type ID needs to be configured.

Downloaded PDFs are processed locally as temporary files. The extension removes temporary files after processing and performs cleanup of older temporary files from interrupted sessions. Original documents in Paperless-ngx are not modified.

Paperless credentials are configured in Raycast preferences, not embedded in the source code. The API token uses a password-type preference.

## Password-protected PDFs

The PDF is unlocked for reading without modifying the original file. A password can be stored in the macOS Keychain and reused automatically. The saved password is tried for **other encrypted PDFs as well**; it is not currently restricted to a particular pharmacy or sender. If it does not work, Raycast prompts for another password. Passwords are not placed in transfer-draft JSON or the source repository.

Each Mac must have access to the relevant Keychain entry; cloning the repository alone does not transfer passwords.

## How the handoff works

The extension creates an atomic JSON draft in:

```text
~/Library/Application Support/simplebanking/transfer-drafts/
```

The draft includes payee name, validated IBAN, amount in EUR, payment reference, creation time, and a short expiration time. The simplebanking filesystem watcher detects the file and opens simplesend. When simplebanking is already running, the extension does **not** call `open -a` again. If simplebanking is not running, it launches the app.

Depending on the installed simplebanking version, launching a stopped app may still show its main window.

## Project layout

```text
rechnung-ueberweisen/
├── assets/
│   ├── extract.swift          # PDFKit, Vision, PDF unlocking, Keychain
│   ├── command-icon.png
│   └── transfer-icon.png
├── src/
│   ├── extract.ts             # Payment-data parsing and candidate selection
│   ├── rechnung-ueberweisen.tsx  # Invoice form and simplesend handoff
│   └── rechnung-aus-paperless.tsx  # Paperless-ngx search and download
├── package.json
├── package-lock.json
├── raycast-env.d.ts
└── tsconfig.json
```

## Limitations and safety

- PDF extraction is heuristic. Always verify payee, IBAN, amount, and reference before authorizing a payment.
- The debit account is selected inside simplesend, not by this extension.
- This extension is a local convenience tool, not a payment service or a substitute for bank verification.
- The current UI is German-only.

## Contributing

Issues and pull requests are welcome. Please do not include real invoices, personal banking data, credentials, or unredacted screenshots in public reports.

## License

MIT — see the repository's root `LICENSE` file.
