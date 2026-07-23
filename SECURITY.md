# Security policy

## Supported versions

Sangam is pre-1.0 software. Security fixes are provided for the latest `0.1.x`
release only. Operators should deploy immutable image digests and upgrade after
reviewing the release notes and completing the backup procedure.

| Version | Supported |
| --- | --- |
| Latest `0.1.x` | Yes |
| Older releases and source snapshots | No |

## Report a vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository's
**Security** tab to submit a private vulnerability report. Include the affected
version or image digest, reproduction steps, impact, and any proposed mitigation.
Please avoid accessing data that is not yours and do not publish details until a
fix and coordinated disclosure plan are available.

We will acknowledge a complete report within five business days, keep the reporter
updated while it is assessed, and credit the reporter in the advisory unless they
prefer to remain anonymous.

## Deployment boundary

The development Compose file is for loopback-only evaluation. Internet-facing
deployments must use the production configuration, an authenticated reverse proxy,
an isolated trusted-preview origin, off-host encrypted backups, and the verification
steps in `docs/operations/RELEASE_CHECKLIST.md`.
