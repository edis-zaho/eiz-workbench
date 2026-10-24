# Validation — 0.19.0-alpha.1

Checked on 24 October 2026 on Windows x64 using Node 24.19.0 and Electron 42.11.2. This describes a developer release candidate, not a production certification.

| Check | Result |
|---|---|
| Separate export and fresh locked dependency installation | Passed; 377 packages installed from available cache, without copying the development node_modules directory |
| TypeScript checks | Passed |
| Product test suite | 650 passed, 0 failed, 0 skipped |
| Electron entry-point syntax | Passed |
| Application and optional relay builds | Passed |
| Relay package and operational tests | Passed |
| Synthetic source desktop workflow | Passed |
| Synthetic workflow against the final packaged app.asar | Passed; 4 mock model calls and 1 mock send, no live providers |
| Packaged-file allowlist and private-material pattern scan | Passed; no violations found |
| Dependency inventory | 377 installed packages, no missing license declarations; supplied notices preserved, including Electron/Chromium runtime notices |
| Checkpoint helper without explicit paths | Rejected as intended, before reading a profile |
| Independent source-export/documentation review | Two findings corrected and independently rechecked |
| Windows NSIS installer build | Passed; unsigned |

The desktop test covers an empty public profile, product/source review, six model routes, credential storage, budgeted model analysis, CSV deduplication, contact permission review, mock Gmail OAuth, named UTF-8 multipart signature, cancelled/confirmed send, reply reading/analysis and encrypted backup/restore. The model-cost error cases intentionally produce error logs and retain the reservation; their presence is part of the negative test, not a failed build.

The independent review led to two corrections: the developer checkpoint CLI now requires an explicit profile directory, and the build guide no longer presents the hidden smoke harness as an interactive development profile. The helper writes plaintext and should only be used with synthetic data; use the application's encrypted backup for real data.

## Scope of the evidence

- No live Gmail delivery, real model quality, paid API request or external-user acceptance was tested for this alpha. These remain outstanding.
- The final alpha package was built and its archived application exercised. A fresh installer/reinstall/uninstall test in the offline Windows VM was performed for the preceding pilot.7, not repeated for this alpha packaging candidate.
- Dependencies were installed independently from the lockfile using the local cache. A completely uncached download on another machine has not been tested.
- License inventory records package declarations and preserves supplied notices. Some development dependencies do not supply a root-level notice; the inventory marks them. This is not an exhaustive legal review.
- The export excludes private Git history, profiles, credentials, customer documents and prior artifacts. Pattern scans and review reduce accidental disclosure risk; they are not a proof that every possible secret or security defect is absent.
- No exhaustive security audit or production SLA is claimed. See LIMITATIONS.md and SECURITY.md.

## Reproduce

Follow BUILD.md. Run `npm run verify`, `npm run test:desktop`, `npm run package`, then `node scripts/test-desktop.cjs --packaged`. Each test creates isolated synthetic data under qa/. Do not ship qa/ or your own profiles.

SOURCE-MANIFEST.json records the included source and notice hashes. The review bundle supplies SHA256SUMS.txt for the source ZIP and Windows installer. Raw local test logs are retained separately and are intentionally not published with the source.
