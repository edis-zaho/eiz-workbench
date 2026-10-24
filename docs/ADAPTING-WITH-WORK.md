# Adapt the Workbench for your company with Work

Open source gives your team inspectable, editable code. Work or another coding assistant can help once it has access to your local clone. It does not automatically know your business rules or gain access to your Gmail/API accounts.

## Why Work is the example

This guide addresses teams already exploring AI-assisted, low-code or prompt-led software building. The next step here is adapting an existing local application with source access. Work is the author's chosen development tool, not a required subscription or a component of the deployed Workbench. Other coding assistants or developers can follow the same process. Familiarity with a web-app builder does not by itself establish that it can build or test an Electron/Windows application.

## Define a useful first company version

Choose one workflow and name its owner. Write down the input, the desired outcome, the decisions that must follow fixed rules and the outputs that need review. For example: import a fictional contact list, apply your qualification criteria, prepare drafts in your approved tone, stop follow-ups on replies and make the next action visible to the responsible person.

Adapt the smallest missing pieces first. Validate them with synthetic examples, then conduct a limited live trial using explicitly authorized accounts. One to two months can be a planning target for a bounded adaptation; it is not an estimate for arbitrary integrations, shared-user operation or replacing a full CRM. Budget for the owner's time, technical review and ongoing maintenance as well as the development tool. Subscription allowances for Work do not fund the Workbench's runtime model API calls.

## Start with a small, testable change

1. Clone or unpack this source into a separate development folder. Install locked dependencies and pass the baseline checks in `BUILD.md`.
2. Connect that folder as the coding workspace in your assistant. Ask it to read `AGENTS.md`, `docs/ARCHITECTURE.md` and the relevant tests before proposing edits.
3. Describe one desired outcome, concrete examples and what must stay unchanged. Use fictional contacts/products. Never paste API keys, OAuth tokens, real message archives or production databases into a prompt.
4. Review a short plan and changed files. Give approval for the development task, not for live sends or spending.
5. Run targeted tests, `npm run verify`, and the synthetic desktop test when UI/native integration changes. Review the diff and test evidence yourself.
6. Try the fork in a distinct profile with your own authorized test accounts only after reviewing data flows. Keep an encrypted backup and a rollback version. Never treat a green simulation as a live acceptance result.

## Ready-to-use task brief

```text
Read AGENTS.md and docs/ARCHITECTURE.md first.
We are adapting EiZ Workbench for our company.
Outcome: [one specific change and a before/after example].
Allowed files/area: [area or ask you to identify it first].
Use only synthetic examples. Do not access production profiles, send real
messages, call paid APIs, publish, or change dependencies.
Preserve mailbox binding, send reservations, stop rules, budget checks,
credential isolation and backup/restore behavior.
Show a short implementation plan, implement the approved change, run the
relevant tests and npm run verify, and explain any untested behavior.
```

## Where common changes belong

| Request | Starting point | Proof to request |
|---|---|---|
| Company wording, terminology, screen guidance | Relevant `src/` view | Rendered screen plus desktop flow; no change to send authority |
| Persona/angle instructions | Prompt construction and relevant validators in `core/` / `electron/` | Fixtures with unsupported claims and missing facts; approval still required |
| Business-specific contact qualification | Existing contact/permission/rule modules in `core/` | Positive and negative eligibility tests; opt-outs still stop delivery |
| Another model profile | Prefer existing configuration first | Provider contract, JSON/text output and billing checks before real use |
| New provider implementation | Native adapter plus usage/endpoint contracts | No key forwarding to another host, no retry of uncertain calls |
| New database fields | Store/schema/export/restore | Upgrade, round-trip backup, old backup and recovery tests |

## Company fork identity

Before running alongside the upstream app, review `package.json` (app ID/product name), `electron/main.cjs` (app name) and `electron/profile.cjs` (data-directory selection) together. An app ID rename alone does not isolate data. Add a test proving the fork opens a separate empty profile and leaves the existing profile untouched. Do not rely on the synthetic-harness environment variable for normal production operation.

## What to leave intact

Never solve friction by removing final send checks, silently granting contact permission, logging secrets, disabling budget reservations, treating an uncertain call/send as free or unsent, or automatically restarting work after restore. These are correctness contracts, not optional UI confirmations.

MIT permits internal and commercial customization, including private modifications. Preserve the license/copyright notices and dependency notices. Recheck third-party licenses and provider requirements when adding integrations. No maintenance service, hosting, account access or support SLA is included.
