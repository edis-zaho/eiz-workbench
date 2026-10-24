# Contributor and coding-assistant instructions

Read README.md, docs/ARCHITECTURE.md and the task-specific code/tests first.

- This is a Windows developer alpha. Preserve Electron, React, TypeScript and SQLite unless a maintainer explicitly approves a different architecture.
- Make the smallest task-scoped change. No dependency upgrades or unrelated refactors.
- Use synthetic data and temporary profiles. Never open a production profile or include secrets/customer content in prompts, logs, commits or fixtures.
- No live emails, paid provider calls, deployments or publication unless explicitly requested separately.
- Preserve native credential isolation, authenticated loopback/worker boundaries, exact model destinations, cost reservations and unknown-result reconciliation.
- Preserve mailbox binding, once-only send reservations, final eligibility checks, opt-outs, bounce/response stops and separate conversation approvals.
- Never auto-resume after restore or make an uncertain send retryable.
- For schema changes test migration, export, restore and old-backup behavior.
- Run targeted tests then npm run verify. Run npm run test:desktop for UI/native changes. Tests must not be removed or weakened to manufacture success.
- Report observed results, assumptions and untested cases separately. Stop after the requested scope; do not publish.
