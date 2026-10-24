# Security and sensitive reports

This is a developer alpha, not a security-certified product. Only the current alpha is a maintained review target; no fixed response-time commitment is made.

Do not post credentials, customer databases, full emails, access URLs or working exploitation details in a public issue. Use GitHub's private vulnerability reporting option in this repository's Security tab. If that option is unavailable, open a minimal issue asking for a private contact channel without sensitive details.

Useful reports identify the affected version and component, a minimal synthetic reproduction, expected/observed behavior and practical impact. Important boundaries include Electron preload/native IPC, loopback worker authorization, provider destinations, encrypted credential storage, Gmail identity/send evidence, budget accounting and backup/restore.

The active SQLite database is not application-encrypted. Backup exports and credentials use separate protection. Keeping data local does not remove the need to secure the Windows account and disk. Review docs/LIMITATIONS.md before real use.
