# Set up your own instance

Complete the synthetic build/desktop checks before using real accounts. These steps describe configuration; they do not grant permission to contact third parties.

## 1. Workspace and product

Create a customer workspace, including for your own company. Add a product, source material and factual offer boundaries. Review sources and claims before requesting model proposals. Import a small synthetic contact CSV first; review field mapping, duplicates and contact permission separately.

## 2. Gmail

This developer alpha expects **your own Google Cloud project and Desktop OAuth client**, not an API key. In Google's console enable Gmail API, configure the OAuth consent audience and test users as appropriate, and create a Desktop application OAuth client. Download its JSON configuration and import it from Gmail settings. Do not commit or share that file.

Connect the intended account, then save the sender name and full signature. Read access and mailbox synchronization are separate setup steps. Check which account/scopes are shown before consenting. Google's current verification, testing-mode and account policies apply; this project has no central production Google approval. Current UI wording may differ in Google's console; refer to its official OAuth documentation.

Preview a test message and its signature before authorizing a send to an address you control. Check the real received message and an actual reply. An ambiguous send result must be reconciled, not blindly retried. Automated tests mock Google and are not a substitute for this live acceptance step.

## 3. Models and budgets

In **Modelle & Kosten**, select or create an exact provider/model profile. Add your own API key through the local settings UI; a chat subscription is not automatically an API account. Use a documented price and input/output limit, select the matching currency and set per-call/day/month limits. Template prices have a dated reference and require checking before use.

Assign profiles to the six tasks. The capability test uses synthetic content but, with a real provider connected, can incur provider charges. Approve only after reviewing the destination, transmitted content and reserved maximum. A compatible local endpoint can be configured, but the app does not install or qualify local models for you.

Unclear costs stay held. Check the provider bill before entering a confirmed amount and note under **Kostenlimit → Ungeklärte Modellkosten prüfen**. This changes accounting only and does not repeat the call.

## 4. Controlled workflow

Review product facts, contact source and eligibility, generated messages and sequence timing. Activate live sending only for a deliberately limited test. Replies, opt-outs and bounces must stop further sequence contact. Reply drafting and reply sending are separate actions. Keep the app running and PC awake; no external scheduler is supplied.

## 5. Backups and operations

Create a password-protected export, test its restore in an isolated environment and protect the password separately. Restores pause execution and require reconnection/review. Removing the Windows program does not automatically remove customer data. Active database files are not application-encrypted; protect the Windows account/storage. Review deletion previews carefully, especially when a whole customer history must be removed.

Optional relay/website observation code requires its own deployment and operational review. No relay is deployed, configured or paid for by installing the desktop app.
