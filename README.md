# Raycast Extensions

Open-source Raycast extensions for macOS.

## Extensions

### Rechnung überweisen (Invoice to Bank Transfer)

A Raycast extension that extracts payment information from PDF invoices and prepares SEPA bank transfers using simplebanking / simplesend.

Features:
- Read PDF invoices selected in Finder
- Extract SEPA payment data from EPC QR codes
- Extract payment details from PDF text
- Unlock password-protected PDFs
- Store PDF passwords securely in macOS Keychain
- Review and edit payment details before submission
- Send prefilled transfer drafts to simplebanking / simplesend
- Launch simplebanking only when necessary

Source code: [extensions/rechnung-ueberweisen](extensions/rechnung-ueberweisen)

## Requirements

- macOS
- Raycast
- simplebanking with simplesend support

## License

MIT License.
