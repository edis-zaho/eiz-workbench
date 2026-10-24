# EiZ Workbench — open-source Gmail & AI sales workflows

A customizable **sales automation and CRM workflow foundation** for Windows: connect Gmail, review replies, manage email follow-ups and choose your AI model provider. Local SQLite storage and rule-based controls keep the workflow inspectable. **MIT licensed · developer alpha.**

A local, open-source Windows foundation that companies of any size can adapt to their own B2B processes — from small teams to departments within large enterprises, with their developers, ChatGPT Work or another coding assistant.

**Version 0.19.0-alpha.1 · MIT · developer preview.** Built from the tested pilot.7 code. Intended for developers, GTM engineers and technically supported business teams. It is a foundation for adaptation, not a claim of enterprise-wide deployment readiness, a turnkey service or an autonomous salesperson.

## Why this exists

Companies should be able to shape their software around their processes. Teams across startups, established businesses and large enterprises need combinations of product knowledge, qualification, messaging, replies and follow-ups that fit their work. Building every connection and safeguard from scratch is a substantial starting cost.

The Workbench provides that starting code. You can inspect it, adapt it internally or commercially under MIT, and maintain your own version. The vision is to reduce dependence on overlapping subscriptions where a focused company-owned workflow is a better fit. Savings depend on what it actually replaces and the cost of maintaining it; owning source code does not eliminate operating costs.

Publishing at the developer-alpha stage is deliberate. I want companies to bring their own requirements into the project while the next development priorities are still open, and to shape their own versions around their needs. Open source remains adaptable as it matures; the value of sharing early is that practical feedback can influence the direction sooner. This invitation does not replace testing and acceptance before business use.

Work is the chosen example in our adaptation guide because the intended audience includes teams already exploring AI-assisted software building. It can help turn a concrete business requirement into changes to an existing codebase. Work is not a runtime dependency, and you are free to use another development tool. A team member still needs to define the process, review changes and accept the result.

## The person and approach behind the project

I am Edis Zahovikj, the initiator of EiZ Workbench. I developed this project with AI-assisted development tools to connect my sales experience with process design and practical automation.

The project is a working example of how I approach a business problem:

- Translate qualification and customer communication into explicit steps, required information and review points.
- Connect buyer roles and messaging angles to experiments that a team can examine and refine.
- Choose where fixed rules belong and where model-assisted interpretation is useful.
- Bring tool selection, integration, cost controls and recovery into one workflow rather than treating a generated message as the whole solution.

The source, tests and documented limits make those decisions inspectable. They are evidence of the work on this project, not a claim of proven customer results or independent production certification. The architecture and adaptation guides explain the implementation and how to change it.

My contribution to a company-specific version starts with understanding how that company works: what qualifies an opportunity, which decisions matter, where people should spend time and which tools are actually needed. If you are evaluating collaborators for that work, this repository is a practical sample of my approach.

## Reuse is the point

You are welcome to copy, use, adapt and build on this foundation, including for commercial work under the MIT license. Preserve its required license and copyright notices. You do not need to hire me or use Work to make your own version. Contributions and shared improvements are welcome, but reuse is not conditional on contributing back. The aim is for the foundation to be useful beyond my own business.

## Who it is useful for today

- B2B teams in companies of any size with a clearly defined workflow and someone responsible for its technical operation.
- Departments within large enterprises evaluating an inspectable foundation for a specific process, with their own engineering, IT and security review.
- Founders, sales operations teams and GTM engineers who want to adapt qualification rules, product information, messaging and follow-up processes.
- Developers building a company-specific application on existing Gmail, model, storage and approval components.

A practical first project is one product, one authorized Gmail account and one reviewed workflow with synthetic test contacts. This alpha is not yet a ready-made replacement for a shared enterprise CRM, an unattended service or a product requiring no technical ownership.

Enterprise departments can evaluate and adapt the source, but the alpha does not provide central identity management, a shared multiuser workspace or a team role/permission system. Organization-wide deployment would require additional engineering and acceptance against that organization's requirements. The intended audience is broad; the current supported operating scope remains a local Windows application.

## Rules run the workflow; models assist with language and analysis

Code governs sending permissions, sequence stops, cost reservations, recovery and approval boundaries. Models help analyze offers, propose buyer roles and messaging angles, structure information, interpret replies and draft text. Their outputs are proposals or inputs to reviewed workflows; a fluent answer is not proof of a correct qualification.

This separation makes the model replaceable without asking it to control the entire application. It also keeps the important distinction between a reliable process rule and an interpretation that may need human review.

## What is here

- Product knowledge, source review, buyer personas, messaging angles and experiments.
- CSV contacts, reviewed contact permissions, campaign previews and follow-up sequences.
- Gmail connection, named sender and signature, reply reading/analysis, stop rules and reconciliation of uncertain sends.
- Your own API profiles: OpenAI Responses, Anthropic, Gemini and compatible Chat Completions endpoints. Six task routes, local encrypted credential storage and cost reservations.
- Local SQLite data, encrypted backups, controlled restore and deletion previews.
- Existing tests and guidance for adapting the code with a developer or **Work**.

The application has no mandatory EiZ cloud service or EiZ model surcharge. **Free source code does not mean free API usage:** model providers charge for their services. Gmail/Google account requirements still apply. Optional tracking relay code is included, requires separate hosting and is not needed for the basic workflow.

For developers exploring open-source CRM customization, Gmail automation, sales engagement or GTM engineering, this repository provides reusable workflow components. It is a local desktop foundation, not a shared multiuser CRM or a hosted SaaS service.

## Adapt it with Work

1. Unpack or clone the source into a development folder, read the architecture guide and establish a passing baseline.
2. Describe one process change with examples: which contacts qualify, which information is required, who approves a message and when a sequence must stop.
3. Ask Work to identify the affected code, propose a small change and implement it using synthetic data. Review the diff and tests; keep credentials and business records out of the development prompt.
4. Validate the adapted workflow with authorized test accounts before business use. Assign responsibility for backups, updates and future changes.

The [Work adaptation guide](docs/ADAPTING-WITH-WORK.md) includes a reusable task brief and a map of common changes. Start with terminology, approved messaging or one qualification rule; additional integrations, shared access and data migrations are larger projects.

A first tailored version within a few weeks or one to two months is a **planning hypothesis for a bounded scope**, not a delivery guarantee. As checked on 24 October 2026, OpenAI lists Pro from **USD 100/month**; Work and Codex share usage allowances. One or two months of that subscription is a development-tool budget, not the total price of bespoke software. Staff time, review, maintenance, infrastructure and any extra usage remain separate. Runtime API usage is also separate from that subscription. Check [current OpenAI pricing](https://learn.chatgpt.com/docs/pricing) before budgeting.

## Local models and control over data

The application stores its working database locally. A compatible locally hosted model is an architectural option; the current custom adapter supports Chat Completions endpoints, including HTTP loopback. A model server on another device needs a compatible, securely configured connection.

For example, NVIDIA documents [local model serving on DGX Spark](https://build.nvidia.com/spark/vllm). The Workbench remains a Windows application; Spark would serve the model separately. **This alpha has not been accepted end to end with a Spark or a specific local model.** Output quality, structured responses, speed and usage reporting must be checked for the actual workflow.

Local inference can keep model inputs within company-controlled infrastructure. Gmail still processes email, and using a cloud model sends selected content to that provider. The vision is greater control and a choice of data flows, not a claim that all data remains local in every configuration.

## Build and start

Windows 11 x64, Node.js **24.x** with npm, and a terminal in this directory:

```powershell
npm ci
node node_modules/electron/install.js
npm run verify
npm run test:desktop
npm start
```

`verify` compiles the application and runs the product and relay checks. Desktop tests use an isolated synthetic profile and mock external providers. `npm start` opens a real local profile: it does not itself authorize email sends or model calls. See [Build instructions](docs/BUILD.md) before packaging or modifying identity/profile paths.

## Learn and adapt

- [Setup: Gmail, models and first workflow](docs/SETUP.md)
- [Architecture and where to change things](docs/ARCHITECTURE.md)
- [Company customization with Work](docs/ADAPTING-WITH-WORK.md)
- [German quick start](docs/START-DE.md)
- [Known limits and validation status](docs/LIMITATIONS.md)
- [Contributing](CONTRIBUTING.md) · [Security reporting](SECURITY.md)

## Read before using business data

Own Google OAuth configuration and API credentials are required. The desktop runtime stores its database locally; selected content is sent to Gmail and the chosen model provider when authorized. The active SQLite database is **not application-encrypted**. Credentials and backups have separate encryption. Keep Windows and storage protected.

The app must be running and the PC awake for background work. It is not a shared team CRM. Advanced screens are mainly German. The Windows installer is unsigned. Live Gmail/provider acceptance and external user trials are still outstanding; simulated tests do not prove delivery, model quality or commercial results.

## License

[MIT](LICENSE) applies to the project's original code and documentation. You may adapt it internally or commercially, including with coding assistants; preserve the copyright and license notice. Dependencies retain their own licenses: see `THIRD_PARTY_NOTICES.md` and `third-party-licenses/`, generated by `npm run licenses`. No affiliation or endorsement by Google, OpenAI, Anthropic or Microsoft is implied.
