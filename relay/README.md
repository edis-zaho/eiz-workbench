# Optional observation relay

This separate Node 24/SQLite service records registered pixel/link requests as technical observations. The desktop integrates registration and reading, but no hosted relay is supplied or enabled by default. Basic Gmail/model operation does not need it.

Build with `node scripts/build-relay.mjs`. The result is `output/relay-build/run.cjs`. Local contract and operations tests are included in `npm run verify`. Public hosting, DNS, TLS, backups and privacy/retention decisions require a separate operator plan and live validation; none is provisioned here.

Generate a new configuration using the CLI's `--init` operation with your own exact allowed domains; never reuse example credentials or commit configuration. Read `run.ts`, `contract.ts` and deployment samples before operating it. Run one process per persistent database. The deployment samples are examples, not a completed infrastructure setup.

Keep access/error logs from recording token-bearing URLs. Back up the database and protect configuration keys separately. `deploy/backup.mjs` and service/timer samples require operator-specific paths and storage. Tracking URLs have a limited lifetime; inspect the configured contract before sending live links. Observations do not themselves establish identity, intent or permission to contact.
