# Changelog — Rechnung überweisen

All notable changes to this Raycast extension are documented here.

## [0.8.0] — 2026-11-09 (proposed)

### Added

- **Rechnung aus Mail** command for selecting PDF attachments from the combined Apple Mail inbox.
- Initial scan of 30 recent messages and an action to load 100 additional messages at a time.
- Separate list entries for multiple PDFs in the same message, including attachments with identical filenames.
- Validation of the selected Mail account, mailbox, message ID, attachment position, and filename before saving.

### Improved

- Faster initial Mail results by limiting the initial scan and retrieving message metadata only when PDFs are found.
- Amount extraction for `123,45 €`, `123,45 EUR`, and `EUR 123,45`, with ranking that favors payable totals over incidental amounts.
- PDF header verification without reading the entire temporary file into memory.
- Temporary Mail PDF cleanup and validation.

### Verified

- Finder, Paperless-ngx, and Apple Mail invoice extraction against the same test invoice.
- Correct selection of two different PDF attachments sharing the same filename.
- Additional Mail message loading and successful Raycast build.

### Safety

- No automatic transfer authorization; users must review and authorize payments in simplebanking.
- The Mail integration operates on temporary copies of attachments and does not intentionally modify Mail messages.

## [0.7.0]

### Added

- Optional Paperless-ngx integration with document type `Rechnung` filtering.
- Raycast preferences for Paperless-ngx server URL and password-type API token.
- Temporary PDF download and cleanup for Paperless-ngx documents.

### Changed

- Updated extension icon.

The Finder workflow remained available without Paperless-ngx.
