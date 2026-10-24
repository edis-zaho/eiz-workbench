# Scope and evidence

This release is a developer alpha derived from pilot.7. It is useful as an editable foundation for technically supported Windows/Gmail workflows, not as a turnkey mass-market app.

## Known limits

- Windows is the accepted desktop target. Detailed screens are primarily German. No implemented Outlook adapter.
- Own Google OAuth configuration, provider keys, prices and budgets are required. No central Google production approval or included API credits.
- Active SQLite data is not application-encrypted; credentials and backups are separately protected.
- PC/app must remain active for background work. No 24/7 availability, automatic updater or team-role/shared-database product is supplied.
- Free-form model replies need review. Automation is bounded by existing approved rules/templates, not an unconstrained sales agent.
- A contact with linked history may require explicitly deleting the whole customer dataset. Exported copies and Gmail messages require separate treatment.
- Installer is unsigned. Review Windows warnings; do not disable system protections indiscriminately.
- No live-provider acceptance or external-user trial is claimed for this alpha. Delivery, model quality, legal suitability and business outcomes are not established by unit tests.

## Validation

Pilot.7 passed 650 product tests, synthetic source/packaged desktop checks and fresh offline Windows install/reinstall/uninstall with data preservation on 24 October 2026. The developer export is checked separately; see `VALIDATION.md` for its exact results. Tests use fictional data and mocked external providers. No paid API call or real email is part of the automated acceptance.

The three pilot.6 defects were repaired before export: locally composed HTTP diagnostics, explicit accounting reconciliation for unknown model costs, and unrelated test mail no longer blocking deletion of an unused contact. Billing notes are redacted on customer deletion. These facts do not establish complete security or absence of further bugs.
