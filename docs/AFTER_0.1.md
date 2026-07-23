# After 0.1: missing work and discussion backlog

> Created: 2026-07-23
>
> Baseline: released `v0.1.0` at `fc8f87f`
>
> Purpose: discuss and prioritize what comes after 0.1; this is not an
> implementation commitment or a claim that every item belongs in 0.1.x

## Current position

Sangam 0.1.0 is released as a signed, attested, multi-platform self-hosted beta.
The complete application image is available at:

- GHCR package: [jayshah5696/sangam](https://github.com/jayshah5696/sangam/pkgs/container/sangam)
- version tag: `ghcr.io/jayshah5696/sangam:0.1.0`
- immutable digest:
  `ghcr.io/jayshah5696/sangam@sha256:8ee161116bfc2976524ccfe57c4ecc1697f151fa7481434a76264137009d4974`
- GitHub Release: [v0.1.0](https://github.com/jayshah5696/sangam/releases/tag/v0.1.0)
- evidence: [0.1.0 release report](./0.1_RELEASE_REPORT.md)

The package page and anonymous `0.1.0` manifest are reachable. The problem raised
about GHCR is therefore **discoverability and setup documentation**, not a missing
published image.

## First follow-up: make the release obvious in the README

### What the README has today

The README correctly says that the container is the complete application artifact,
explains that the wheel is backend/CLI-only, and shows production Compose with:

```bash
export SANGAM_IMAGE=ghcr.io/jayshah5696/sangam@sha256:DIGEST
```

That is safe as a generic pattern, but it is incomplete for an actual 0.1.0 release.
Someone landing on the repository has to discover the release, package page, current
digest, and verification instructions elsewhere.

### Proposed README work

- [ ] Add a short **Install Sangam 0.1.0** section near the top, before integration
  configuration and screenshots.
- [ ] Link the GitHub Release and GHCR package page directly.
- [ ] Show both installation choices and explain their different trust properties:
  - `:0.1.0` is convenient for trying the release;
  - `@sha256:...` is the production and reproducible deployment form.
- [ ] Provide a copy-paste production Compose example using the released digest,
  while explaining that operators should re-read the digest from the release page
  rather than blindly trusting copied documentation forever.
- [ ] Provide a minimal local evaluation command using persistent volumes and a
  loopback-only port.
- [ ] Link the release checklist, production configuration, upgrade/rollback
  runbook, and final release report from the install section.
- [ ] Include the cosign and GitHub attestation verification commands beside the
  package rather than only in operations documentation.
- [ ] State clearly that the public container can be pulled without a GitHub login;
  authentication is needed only if package visibility changes or registry limits
  require it.
- [ ] Add a release/version badge only if it is generated from GitHub rather than
  manually edited.
- [ ] Add `AFTER_0.1.md` to the project-document index so the discussion backlog is
  easy to find.

Suggested command shape for that future README change:

```bash
# Convenient evaluation by release tag.
docker pull ghcr.io/jayshah5696/sangam:0.1.0

# Production deployment by the verified immutable digest.
cp .env.example .env
export SANGAM_IMAGE='ghcr.io/jayshah5696/sangam@sha256:8ee161116bfc2976524ccfe57c4ecc1697f151fa7481434a76264137009d4974'
docker compose -f deploy/compose.prod.yaml pull
docker compose -f deploy/compose.prod.yaml up -d
```

This section is intentionally a proposal. The README has not been changed as part of
creating this backlog.

## What the readiness audit already closed

The original [0.1 readiness audit](./0.1_READINESS_AUDIT.md) is a historical audit of
revision `33610e5`. Its P0 findings should not be copied into a new backlog as though
they were still present.

The 0.1 implementation closed:

- per-document mutation/materialization/search serialization;
- generation-consistent paired backups and cross-artifact verification;
- distinct audit-event identity with operation correlation;
- administrator-only global chat configuration changes;
- truthful browser draft failure and recovery behavior;
- migration naming, checksum, duplicate, and unknown-newer governance;
- production fail-closed configuration and checked settings/Compose parity;
- clean wheel and source installs with packaged migrations;
- protected CI, release automation, multi-platform GHCR publication, signing,
  SBOM, provenance, attestations, and release assets;
- readiness, stale reconciliation repair, recoverable proposal application, bounded
  PDF streaming/extraction, and bounded shutdown;
- exact save-conflict recovery and exact revision/page/annotation citations;
- explicit confirmation of public chat side effects and least-privilege token UI;
- keyboard tabs and splitters, live status, contrast fixes, narrow modal navigation,
  query gating, lazy routes, and deferred ChatKit loading; and
- actual desktop/narrow browser, package, Compose, container, and released-digest
  verification.

Those outcomes are release evidence, not after-0.1 work.

## Remaining work from the readiness audit

### A. Production acceptance evidence

These are the highest-priority next steps because they determine whether a real
installation can be called production-accepted. Most require operator credentials
and infrastructure rather than product code.

- [ ] Deploy the immutable 0.1.0 digest to the intended host.
- [ ] Quiesce writes and create a fresh paired database/workspace backup from real
  data before any migration or upgrade.
- [ ] Copy the verified backup to an encrypted, separate failure domain and verify
  checksums there.
- [ ] Restore that backup on a clean target and rehearse the migration, restart, and
  rollback paths.
- [ ] Record the previous image digest, target digest, backup ID, restore evidence,
  and deployment log.
- [ ] Prove Cloudflare Access allows the intended administrator and denies another
  identity on both the application and ChatKit API.
- [ ] Prove the trusted-preview hostname, CSP, parent origin, and rejection of the
  main application hostname.
- [ ] Exercise public, unlisted, and private publications from outside the origin
  network.
- [ ] Register the production ChatKit domain and complete a real OpenRouter streaming
  turn, stop/retry, citation, proposal review, and proposal application.
- [ ] Connect the real Karakeep instance, exercise import/refresh, and rehearse API
  key rotation.
- [ ] Run desktop and narrow browser acceptance against the deployed digest with no
  unexpected console or network errors.
- [ ] Prove alert delivery for readiness, backup age/failure, disk capacity, process
  restart, job backlog, integration failure, and origin reachability.

Discussion question: do we call 0.1.0 only a **released self-hosted beta** until this
ledger is attached to one real installation, or do we want a separate
`0.1-production-acceptance.md` per deployment?

### B. Backup, upgrade, and disaster recovery

- [ ] Add encrypted off-host replication rather than leaving verified backups on the
  same host volume.
- [ ] Track and display local snapshot age, most recent verification age, off-host
  copy age, and clean-restore age as distinct facts.
- [ ] Periodically reverify old backup sets; a historic `verified_at` is not permanent
  proof.
- [ ] Add alerting for missed backup, failed verification, failed copy, retention
  failure, and restore-drill expiry.
- [ ] Decide whether Sangam should automatically create a pre-migration backup or
  whether migrations remain an operator-controlled quiesced workflow. The current
  release has a safe runbook but does not create a pre-migration backup before
  application startup applies migrations.
- [ ] Decide the supported off-host target and retention model before implementing
  it: object storage, restic/Kopia, Litestream plus workspace backup, or another
  explicitly tested design.

### C. Backend and API reliability

- [ ] Paginate durable collections that can grow without bound: revision history and
  bodies, PDF pages, annotations, chat proposals, publications, and imports.
- [ ] Separate revision metadata listings from full revision bodies so history does
  not transfer every document version.
- [ ] Return one problem/error schema for service, validation, and unexpected
  failures, always carrying the operation ID.
- [ ] Extend readiness with free-disk thresholds and durable job backlog/age. Current
  readiness covers database, schema, writable roots, startup reconciliation,
  pending materializations, and backup freshness, but not these two audit items.
- [ ] Define and test workspace-size limits and performance envelopes so pagination,
  search, backup, reconciliation, and startup targets have measurable acceptance
  criteria.
- [ ] Keep the 0.1 single-application-process write contract explicit. Design a
  cross-process coordination/lease model before advertising horizontal replicas.
- [ ] Add soak and fault-injection tests for SQLite busy pressure, disk-full behavior,
  interrupted atomic writes, large PDFs, long extraction queues, and shutdown during
  mutations/backups.

Discussion question: what workspace scale should 0.1.x promise? That answer should
set the pagination limits, performance budgets, and soak-test corpus.

### D. Security and supply-chain follow-up

- [ ] Re-evaluate the 23 unfixed Debian HIGH/CRITICAL findings on every rebuild and
  patch promptly when the pinned base publishes fixes.
- [ ] Decide whether unfixed findings need a maintained VEX statement after
  exploitability review instead of relying only on visible scanner output.
- [ ] Exercise secret rotation for Cloudflare, ChatKit, OpenRouter, Karakeep, preview
  signing, and Sangam agent tokens on a deployed instance.
- [ ] Verify structured logs and any future metrics never contain document bodies,
  bearer tokens, preview grants, unlisted publication tokens, or provider keys.
- [ ] Add a recurring dependency and base-image review cadence with an owner and
  response expectation.
- [ ] Require an independent approving review when a second maintainer is available;
  the current single-maintainer protection correctly avoids a self-review deadlock.

### E. First-run and deployment-status UX

- [ ] Add a first-run status page that states whether the instance is local-only or
  authenticated and whether production mode is active.
- [ ] Show whether backup, off-host replication, Karakeep, chat, public publishing,
  and trusted preview are configured and healthy.
- [ ] Distinguish **configured**, **reachable**, **last verified**, and **not enabled**;
  do not turn configuration presence into a false health claim.
- [ ] Link every unhealthy status to the exact operator action or runbook.
- [ ] Decide whether this belongs in onboarding, Settings, an Operations route, or a
  small read-only deployment doctor shared by UI and CLI.

### F. Workspace lifecycle and portability

- [ ] Resolve the image/asset content contract. The product should either support a
  minimal image/asset Document flow or explicitly keep 0.1 limited to Markdown,
  HTML, and PDF everywhere in vision and user documentation.
- [ ] Add safe local asset upload, author-preview resolution, broken-asset
  diagnostics, and portable asset references.
- [ ] Add folder rename, move, and delete as controlled service operations.
- [ ] Allow PDFs to move and enter trash without changing their immutable bytes.
- [ ] Add controlled purge and storage reclamation with clear revision, citation,
  publication, and backup consequences.
- [ ] Add batch workspace onboarding with preview, collisions, duplicate hashes,
  stable identities, progress, retry, and a final import report.
- [ ] Add a versioned portable export containing current files, stable-ID/path
  manifest, metadata/provenance, annotations, chat citations/proposals,
  publications, and optional revision history.
- [ ] Keep portable export distinct from a paired Sangam disaster-recovery backup.

Discussion question: do local images/assets belong in 0.1.x because ordinary
Markdown depends on them, or should the content contract explicitly defer them to
0.2?

### G. UI/UX, accessibility, and browser automation

- [ ] Add Playwright coverage for create/edit/autosave/offline/conflict/reconnect,
  revision restore, publication, PDF annotation, Karakeep import, token
  issue/revoke, chat citations, and proposal application.
- [ ] Add automated accessibility checks and manual screen-reader acceptance for the
  file tree, command palette, panels, dialogs, editor, PDF research, chat, and
  settings.
- [ ] Verify zoom/reflow, reduced motion, touch target size, focus return, and
  non-drag alternatives as explicit WCAG 2.2 AA acceptance items.
- [ ] Standardize skeleton, empty, validation, error, bounded retry, destructive
  confirmation, and success-announcement states across every route.
- [ ] Revisit information architecture: keep daily Files/Search/Recent/Published
  primary and group activity, reconciliation, backups, credentials, integrations,
  and model settings under a clearer Operations/Advanced area.
- [ ] Define budgets for initial JavaScript, route chunks, interaction latency,
  memory, and representative large-workspace operations.
- [ ] Continue splitting the editor, PDF, diff, Mermaid, and language assets; the
  production build still reports some chunks above the current warning threshold.
- [ ] Serve hashed static assets with verified compression and immutable cache
  headers in the real production proxy/CDN path.

### H. Operations and observability

- [ ] Add structured request logs with operation ID, route, status, duration, actor
  class, and safe failure category.
- [ ] Add metrics for request latency/errors, SQLite busy time, database/workspace/
  backup size, free disk, pending/conflicted materializations, unresolved
  reconciliation, extraction/import backlog and age, backup/copy/restore age,
  integration failures, and OpenRouter timeout/cost.
- [ ] Add a small operator dashboard or documented scrape endpoint rather than
  requiring database inspection.
- [ ] Add health/readiness, backup, capacity, process, and origin-reachability alerts
  with tested delivery.
- [ ] Define log retention, metric retention, privacy review, and incident-response
  procedures.

## Product roadmap after hardening

These items remain useful, but should follow production acceptance and the 0.1.x
reliability work rather than compete with it.

### Candidate 0.2: connected knowledge and navigation

- expose tag, category, actor, content type, path, source, date, publication, and
  integration filters in the main search experience;
- add phrases, exclusions, query operators, recent searches, and saved searches;
- index internal links and expose backlinks, outgoing links, broken links, and
  unlinked mentions;
- add stable heading/block anchors and an outline with active-heading tracking;
- complete task lists, footnotes, deliberate syntax highlighting, asset diagnostics,
  and copyable stable links; and
- consider a local graph only after the link index is accurate.

### Candidate 0.3: research synthesis and interoperability

- create Markdown notes from selected PDF annotations;
- copy quotes with stable page/source citations;
- export annotations as JSON and Markdown, with annotated-PDF export considered
  later;
- add DOI/ISBN metadata and BibTeX/RIS or a light Zotero bridge;
- add page thumbnails, PDF outline, fit controls, and navigation history;
- create reproducible source packets combining provenance, annotations, notes, and
  revision-pinned citations;
- expose read-only resources and authorized tools over MCP after the existing API
  and capability model proves stable; and
- show exactly which documents, revisions, and selections entered an AI turn.

## Proposed order for discussion

1. README/GHCR discoverability and the exact supported install path.
2. One real digest-pinned deployment and its production acceptance ledger.
3. Off-host backup, restore drill, monitoring, and alerting.
4. Browser workflow CI and accessibility automation.
5. Pagination, error contracts, scale targets, and operator metrics.
6. Assets, ordinary lifecycle operations, batch onboarding, and portable export.
7. Connected-knowledge features for 0.2.
8. Research synthesis and interoperability for 0.3.

## Decisions to make before implementation

- What wording do we want: self-hosted beta, production-ready after acceptance, or
  another support level?
- Is production deployment a single documented reference environment or a general
  contract across Docker hosts?
- Which off-host backup target and retention policy will we support first?
- What workspace size and document/PDF limits must 0.1.x handle?
- Should pre-migration backup become automatic, a CLI workflow, or remain an
  operator runbook?
- Are local images/assets a 0.1.x correctness gap or a 0.2 feature?
- Which browser workflows are release-blocking versus nightly/extended tests?
- When do we add a second maintainer and required independent review?

## Scope to continue rejecting

Unless the product direction changes explicitly, continue excluding:

- multi-user real-time collaboration and live cursors;
- a general agent scheduler or multi-agent workflow builder;
- vector infrastructure before filters, links, and citation UX are excellent;
- a live filesystem watcher or generic bidirectional sync;
- replacing Karakeep or Zotero;
- a full CMS or static-site generator;
- a plugin marketplace before core contracts stabilize;
- WYSIWYG editing, IDE-grade language tooling, and native mobile apps; and
- a global graph before an accurate backlink/link-health index.

## Updating this file

When an item is discussed, record the decision and intended release before starting
implementation. When it ships, replace the checkbox with a link to its PR and
verification evidence rather than simply deleting the history.
