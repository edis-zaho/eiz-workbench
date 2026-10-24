# Architecture map

Electron hosts a React UI and a local Node/SQLite worker. Remote services are reached through explicit native integration paths. Source files and incoming messages are data, not instructions for privileged actions.

| Area | Location | Responsibility |
|---|---|---|
| UI | `src/` | User input, previews, settings and review; React/TypeScript |
| Native boundary | `electron/main.cjs`, `preload.cjs` | Trusted UI checks, limited IPC, dialogs, credentials and external calls |
| Local service | `core/run.ts`, `server.ts` | Loopback API and native worker authorization |
| Persistence | `core/store.ts`, `types.ts`, `public-schema.ts` | SQLite schema/migrations, backups and validated public records |
| Model workflow | `core/model-jobs.ts`, `model-budget.ts`, `model-routing.ts`; `electron/model-dispatch.cjs`, `model-transport.cjs`, `model-adapters/` | Immutable destination, reservation, dispatch, usage, reconciliation |
| Gmail | `electron/google.cjs`, `gmail-provider.cjs`, delivery/sync modules | OAuth, send/read identity, message evidence and recovery |
| Campaigns and conversations | `core/outbox.ts`, campaign/reply/dialogue modules | Qualification, approved sequences, stopping and separate conversation replies |
| Data deletion | `core/data-retention.ts` | Preview-bound deletion, suppression hashes and restore protection |
| Optional tracking | `relay/`, native relay/tracking modules | Separate technical observation service; no hosted service supplied |

## Important contracts

The renderer does not receive provider credentials. The local HTTP API is authenticated; sensitive operations also require the native worker proof. A UI change must not bypass these boundaries.

Model dispatch is tied to the exact profile/version, task, payload and budget. Uncertain calls are not automatically retried; a manual billing reconciliation changes accounting only. Generated text remains a proposal subject to the existing approval flow.

Sending uses persisted reservations, mailbox binding and a final eligibility check. A response stops the contact's sequence. A conversational answer uses a separate approved path. An unknown Gmail result must be reconciled before any resend decision.

Restore preserves known cost/send/suppression evidence and pauses execution. Schema changes require migration, export and restore tests. Current schema is 34. Do not edit SQLite directly to make tests pass or to resume work.

The default build defines `EIZ_PUBLIC_BUILD=true`, starts with an empty profile and uses the public channel. Legacy code paths remain for compatibility/testing; generic example data in those paths is not customer data. The alpha is a maintainable starting point, not a claim that every module is small or that the architecture needs no further work.
