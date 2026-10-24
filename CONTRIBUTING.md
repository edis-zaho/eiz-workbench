# Contributing

Start with the README, architecture map and AGENTS.md. Keep changes small and explain the user problem, resulting behavior, tests and remaining limitations. Use synthetic fixtures only.

Run `npm ci`, targeted tests, `npm run verify` and, for UI/native changes, `npm run test:desktop`. Database changes need migration and restore coverage. No live provider accounts are needed for automated checks.

Do not include `.env` files, credentials, message archives, screenshots with personal data, databases, backups, generated QA folders or historical internal documents. Inspect the staged diff before committing. Dependencies retain their own licenses; regenerate notices with `npm run licenses` after an approved dependency change.

For ordinary bugs use the repository issue form after publication. For security problems use the private reporting route described in SECURITY.md. Contributions are accepted under this project's MIT license; do not contribute code you cannot license accordingly. The alpha carries no promised response time or support SLA.
