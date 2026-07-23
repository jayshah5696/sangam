# Release checklist

This is the required evidence ledger for every Sangam release. A tag is a release
request, not proof that the release is usable. Do not create the tag until all
pre-tag items are checked, and do not deploy until the tag workflow and manual
production gates pass.

## Candidate identity

- [ ] The candidate commit is on protected `main`, required CI is green, and the
  worktree is clean.
- [ ] `pyproject.toml`, `CHANGELOG.md`, and the intended `vX.Y.Z` tag agree.
- [ ] The release notes identify data migrations, security changes, known limits,
  and any manual operator action.
- [ ] `just release-check X.Y.Z` passes from a clean `main` checkout.

The automated preflight covers Python formatting and lint, backend tests, frontend
formatting/lint/build/tests, UI-token checks, docs links/style/Mermaid, settings
inventory, frontend/runtime version propagation, wheel and sdist clean installs,
packaged migrations, Compose parsing, the production-image smoke, and container
vulnerability scans. Trivy prints every HIGH/CRITICAL finding and blocks every
HIGH/CRITICAL finding for which the distribution or package ecosystem publishes a
fix. Unfixed findings remain visible in the job log and must be assessed as release
risk; they do not make the release gate impossible to satisfy. Python runtime and
npm dependency audits use their blocking production-dependency policies before the
container scan.

## Backup and upgrade proof

- [ ] A fresh paired database/workspace backup was created and verified on the
  real deployment.
- [ ] The verified set was copied to a separate failure domain and its checksum
  was checked there.
- [ ] The upgrade was rehearsed against a restored copy of production data.
- [ ] The restore drill in [Upgrades and rollback](./UPGRADES_AND_ROLLBACK.md)
  passed, including PDFs, search, history, publications, imports, chat, and a clean
  reconciliation scan.
- [ ] The previous image digest and pre-upgrade backup ID are recorded in the
  deployment log.

Sangam's verification proves the local snapshot's database integrity, archive
safety, checksums, and database/workspace agreement. It does not replicate or
encrypt that set and cannot prove an off-host copy exists; the operator must attach
separate copy and restore evidence.

## Tag workflow evidence

- [ ] The tag workflow re-ran every source, docs, package, migration, container,
  and vulnerability gate successfully.
- [ ] GHCR contains `linux/amd64` and `linux/arm64` manifests for the version.
- [ ] Deployment uses `ghcr.io/jayshah5696/sangam@sha256:...`, not a mutable tag.
- [ ] `cosign verify` succeeds for that digest and the release workflow identity.
- [ ] GitHub's provenance verification succeeds for the image and downloaded
  wheel/sdist assets.
- [ ] The registry exposes the BuildKit SBOM attestation and the GitHub Release
  contains the wheel, sdist, and `SHA256SUMS`.

Example verification commands are:

```bash
cosign verify ghcr.io/jayshah5696/sangam@sha256:DIGEST \
  --certificate-identity-regexp \
  'https://github.com/jayshah5696/sangam/.github/workflows/release.yml@refs/tags/v[0-9].*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

gh attestation verify oci://ghcr.io/jayshah5696/sangam@sha256:DIGEST \
  --repo jayshah5696/sangam
sha256sum --check SHA256SUMS
```

## Production acceptance

- [ ] `SANGAM_DEPLOYMENT_MODE=production` starts with the intended configuration;
  known development secrets or insecure URLs are rejected.
- [ ] Cloudflare Access allows the configured administrator and denies another
  identity on the application and ChatKit API.
- [ ] The trusted preview uses its isolated hostname, rejects the application
  hostname, and has the expected CSP and parent origin.
- [ ] Public, unlisted, and private publication access was exercised from outside
  the origin network.
- [ ] ChatKit is registered for the production application origin; an OpenRouter
  turn streams incrementally and a proposal can be reviewed and applied.
- [ ] Karakeep connection/import, PDF range delivery/extraction, backup creation,
  readiness, restart recovery, and an agent allow/deny/revoke path pass.
- [ ] Desktop and narrow browser smoke passes with no unexpected console or
  network errors.
- [ ] Monitoring covers readiness failure, backup age/failure, disk capacity,
  process restarts, and Cloudflare origin reachability.

Record links to the CI run, release workflow, GitHub Release, image digest,
attestations, production smoke evidence, backup ID, and deployment log beside the
release entry. Only then mark the release complete.
