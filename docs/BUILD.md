# Build the developer alpha

## Prerequisites

Supported verification target: Windows 11 x64, Node 24.x (including built-in `node:sqlite`) and npm. The reviewed environment used Node 24.19.0. Other OS/Node majors are not accepted targets for this alpha. Use a normal local directory, not a synced production profile.

```powershell
node --version
npm --version
npm ci
node node_modules/electron/install.js
npm run verify
npm run test:desktop
```

`npm ci` installs exactly `package-lock.json`. The explicit Electron install command fetches/extracts its matching runtime if needed, verifies it with the package's supplied checksums, and does nothing when already installed. It is necessary when package installation has not downloaded the runtime. The initial install may download npm packages and Electron. No account, API key, paid service or live mail is needed for verification. Never run tests against your production data directory. If npm blocks lifecycle scripts, review the named package instead of approving all scripts indiscriminately; this tested workflow installs the Electron runtime explicitly.

`verify` checks TypeScript, all `tests/*.test.ts`, Electron syntax, the renderer/worker build, optional relay build and local relay operation tests. Reports are written to ignored `qa/verification/`. It has no dependency on an internal sibling repository. `test:desktop` drives the app with a temporary profile and mocked Gmail/model responses; errors deliberately injected by tests can appear in the console. The final result must say `PUBLIC_DESKTOP_SMOKE_PASSED`.

## Run locally

```powershell
npm start
```

The standard public profile is `%APPDATA%\EiZ Workbench`. Existing installations with that identity share this profile. For development acceptance use `npm run test:desktop`, which creates a temporary profile and runs the synthetic UI flow. Its internal `EIZ_SMOKE_DIR` variable activates a hidden automated test and exits; it is not an interactive sandbox switch. A company fork intended to run alongside the upstream app must first change and test application identity/profile paths as described in the customization guide; do not casually point it at live data.

## Windows installer

```powershell
npm run package
node scripts/test-desktop.cjs --packaged
```

Packaging runs verify, generates third-party notices, then builds an unsigned NSIS installer under `release-public/`. Electron-builder may download packaging tools on first use. `--publish never` is explicit; no GitHub upload occurs. The package includes license notices. The unpacked application is under `release-public/win-unpacked/`.

Do not publish `node_modules`, `qa`, `output`, `.env*`, databases, backups, tokens or this development directory wholesale. Source ZIPs should contain the reviewed tracked source files; installers belong in release assets. A repeatable successful build is not a promise of byte-identical signed executables.

## Troubleshooting

- `node:sqlite` missing: use Node 24.x; do not replace the database layer.
- Electron download/install failed: inspect the actual network/certificate error; keep the lockfile.
- Backup rename/permission error: use a writable local test directory and inspect file locks. Do not disable protection indiscriminately.
- Model/Gmail errors in a real run: these require your own provider setup. They are not solved by editing away application checks.

Optional relay: `node scripts/build-relay.mjs` builds `output/relay-build/run.cjs`. See `relay/README.md`; no cloud resource is deployed by any of the commands above.

`scripts/save-checkpoint.cjs` is a developer/test helper that writes **plaintext JSON**, not an encrypted user backup. Its CLI requires both destination and explicit profile directory. Use synthetic data only; for business data use the app's encrypted export workflow.
