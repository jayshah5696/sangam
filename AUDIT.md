# Repository audit

## Scope and limits

The starting commit was `774fe2a978974c00a9d589acb537d4bac72b3a4c`.
Verification ran with the audit changes applied to that commit, before the changes
were committed for review. No deployment or user workspace was changed.

I inventoried the 628 tracked files, inspected the main backend paths and project
configuration, and ran the backend, frontend, browser, documentation, dependency,
and live behavior checks. The code review concentrated on URL handling, capture,
workspace files, revisions, publication, backups, search, CLI behavior, and access
boundaries. The second pass also inspected document sessions, citation navigation,
PDF geometry, draft storage, and the source-change workflow. Most frontend coverage
still came from the existing checks and browser tests.

This is not a claim that I read every file or found every defect. I did not inspect
every frontend component or test in depth. Passing checks do not prove that all
behavior is correct. The review items below distinguish source findings from
failures reproduced during this audit.

## Fixed and reproduced

### Corrupt backup IDs could redirect retention deletion

`src/sangam/backup.py`, `BackupManager.list`

The backup list accepted a manifest whose `backup_id` differed from its directory
name. Retention then constructed a deletion path from that unchecked ID. A locally
modified manifest containing `../retention-victim` could target a sibling directory.
This requires corrupt or modified local backup storage. It is not an arbitrary
remote deletion endpoint.

The list now rejects mismatched IDs, consistent with the existing `get` operation.
The isolated HTTP verification modified a disposable manifest, triggered retention,
and confirmed that the sibling marker survived and only two valid backups remained.

### Malformed capture URLs raised server exceptions

`src/sangam/ssrf_client.py`, `validate_capture_url`

Invalid ports, unmatched IPv6 brackets, invalid bracketed hosts, and invalid Unicode
host delimiters could raise `ValueError` instead of an application validation error.
The parser now translates these errors. All five cases return HTTP 422 through the
capture API. Existing scheme, port, credential, and network restrictions remain.

### A malformed asset link could break publication content

`src/sangam/publication.py`, `PublicationService._relative_asset_references`

`src/sangam/document_assets.py`, `resolve_asset_reference`

A saved HTML document containing `http://[invalid/` in an image reference could
raise a URL parser exception when publication content was requested. Malformed
references are now excluded from relative assets. Direct asset requests return the
existing not-found response. The isolated verification confirmed readable publication
content with HTTP 200 and a rejected asset request with HTTP 404.

### The CLI failed while reporting upstream errors

`src/sangam/cli.py`, `_request`

The error handler assumed every HTTP failure contained a JSON object with an
object-valued `error`. HTML gateway errors, empty bodies, JSON lists, and string-valued
errors could crash the handler itself.

Non-JSON failures now produce a JSON error containing the HTTP status and reason.
Operation IDs are included when the error structure supports them. Nonstandard JSON
payloads are preserved. Four checks drove the installed CLI against an actual local
HTTP server returning these failures. Each produced the expected output and exit 1.

### Architecture documentation contradicted enforced behavior

`docs/architecture.md`

The introduction incorrectly said every agent edit required human review. It now
distinguishes chat proposals from scoped API writes and YOLO effects. The preview
section now describes production's required HTTPS host isolation instead of claiming
that trusted previews always share the application origin.

### Backups silently omitted unreadable attachments

`src/sangam/backup.py`, `BackupManager._archive_workspace`

The archive operation suppressed filesystem errors. An unreadable attachment that
was not an active document could be omitted while the backup passed verification.
File resolution, archive reads, and directory traversal errors now abort creation.
The existing cleanup removes the incomplete backup. Deliberate exclusions for
symlinks, paths outside the workspace, and readiness files remain.

Tests used filesystem permissions rather than mocked archive calls. The isolated
API returned HTTP 500 for an unreadable file and an unreadable directory, with no
incomplete backup left behind. After permissions were restored, the same request
keys succeeded. A separate restore recovered the attachment's exact content.

### Web search returned sources that the same run could not read

`src/sangam/web_research.py`, `WebResearchService.search` and `_record`

Search returned every provider hit even after the run reached its 50-source storage
limit. A returned source ID could therefore fail the required lookup on read.
Search now returns only sources stored for the run. Duplicate URLs do not consume
additional slots. Sources already stored remain available even when an earlier hit
in the same batch exceeds the limit. The implementation reads the URL inventory
once per transaction rather than counting rows for every hit.

A regression using SQLite covers repeated searches, duplicate URLs, the 50th source,
and later readable sources at the limit. This was a deterministic integration test,
not a live model run that exhausted the source budget.

### Malformed successful search responses caused unhandled exceptions

`src/sangam/web_research.py`, `BraveSearchProvider.search`

The adapter assumed that successful JSON responses contained nested objects and a
list of result objects. It now validates that structure with Pydantic before using
it. Invalid structures produce the existing provider-unavailable application error.
Missing optional result fields remain supported.

Six malformed response shapes failed before the fix and passed afterward. A local
HTTP server also served these payloads to the production adapter through actual
HTTP requests. All six produced the expected application error.

### Updating a citation corrupted its saved URL

`frontend/src/components/document/DocumentWorkspace.tsx`,
`handleUpdateDraftCitationRevision`

Updating a draft citation replaced both the old revision ID and its `?revision=`
prefix with only the new ID. The source-change notice disappeared because the
citation was no longer recognized, not because the saved reference was correct.
The replacement now preserves the query parameter prefix.

The browser regression first failed on the corrupted saved content. It now checks
both the persisted draft and the rendered link's exact URL. It passes on desktop
Chromium, narrow desktop, and touch-mobile Chromium. The captured preview images
show a readable source link within each viewport.

## Items for review

These were not changed. The consequences follow from the cited code, but these
items were not reproduced through a dedicated live regression in this audit.

### High priority

1. **Capture retries do not preserve the original request result.**
   `src/sangam/capture.py:90` fetches again before the downstream idempotency check.
   The generated Markdown includes a fresh fetch timestamp. The default path also
   includes a clock value. Reusing an idempotency key can therefore submit a different
   payload and conflict instead of returning the original capture. Decide whether a
   capture should reserve and replay a result before fetching. Test both Markdown and
   PDF retries, including a project attachment that failed on the first attempt.

2. **Capture can report success without attaching the requested project.**
   `src/sangam/capture.py:159` suppresses every exception from `projects.add_document`.
   A missing project or a persistence failure leaves a captured document without the
   requested membership and gives the caller no failure. Choose between an atomic
   capture-and-attach operation and an explicit partial-success response. Do not
   simply rethrow after creation without deciding how retries recover the document.

### Correctness and efficiency

3. **Default capture filenames can collide.**
   `src/sangam/capture.py:29` uses a title slug and second-resolution suffix.
   Two captures with the same title in the same second can select the same path.
   The function also reads the clock separately from its supplied `now` argument.
   Define collision handling together with retry identity, rather than independently
   adding random filenames and making retries harder to reconcile.

4. **Web pagination downloads the whole page again for every window.**
   `src/sangam/web_research.py:169` fetches and converts the full response before
   slicing each 8,000-character window. This repeats downloads, and a changed page
   can shift offsets between reads. Consider a bounded snapshot per run and source,
   with an explicit freshness policy. No before-and-after performance measurement
   was made, so this is an allocation and consistency observation, not a speed claim.

5. **Large file operations allocate whole files repeatedly.**
   `src/sangam/workspace.py:284`, `:327`, and `:379` use `read_bytes` for hashing and
   copying during trash, restore, and scanning. Large PDFs can produce large temporary
   allocations. The same module already has a streaming `binary_hash` operation.
   Measure peak memory with a large PDF before changing this. Preserve existing
   conflict checks, atomic replacement, and durability guarantees.

### Cleanup and maintenance

6. **Capture retains dependencies it does not use.**
   `src/sangam/capture.py:62` accepts and stores `documents`, `pdf_research`, and
   `extractor`, but the implementation operates through `workspace`, `projects`, and
   `client`. Remove the unused constructor parameters and update composition and
   test fixtures together if no extension depends on those attributes.

7. **Historical evidence conflicts with the current asset policy.**
    Tracked screenshots under `docs/pr-evidence/369`, `370`, and `400` are ad-hoc PR
    evidence rather than canonical UI references. `.audit` contains old issue and
    verification records. Both `.Jules` and `.jules` exist, which is inconsistent on
    case-insensitive filesystems. Review references and retention requirements before
    deleting or moving them. Nothing was deleted during this audit.

8. **Some CI jobs bypass the required `just` interface.**
    `.github/workflows/ci.yml:174`, `:181`, `:182`, and
    `.github/workflows/release.yml:98` invoke scripts directly. Use the existing
    recipes where possible and add a package-smoke recipe if needed. Review release
    behavior before changing the workflows.

9. **Dependency and bundle warnings remain.**
    Backend tests report 85 deprecation warnings from Starlette's AnyIO portal alias
    and ChatKit named widgets. The frontend build warns about chunks over 700 kB.
    Dependency vulnerability checks pass. Review supported dependency upgrades and
    use `just bundle-report` before changing loading boundaries. Large deferred chunks
    alone do not establish a user-visible slowdown.

## Verification

The tested base commit is `774fe2a978974c00a9d589acb537d4bac72b3a4c`.
These checks ran before the audit commit, on the working tree containing its code,
tests, and verification scripts. The report was then updated for PR handoff; no
application code changed after the final checks.

### Regression evidence

- The first pass's 12 new backend regressions all failed before their fixes and
  passed afterward.
- In the second pass,
  `just test-backend-focused 'tests/test_chat_web_research.py tests/test_audit_regressions.py'`
  first reported 9 failed and 17 passed. All 26 passed after the fixes. The nine
  failures covered unreadable backups, source-budget handling, and provider payloads.
- `just test-e2e 'e2e/source-change-recheck.spec.ts --project=chromium-desktop'`
  failed before the citation fix because the saved URL lost its query parameter.
  `just test-e2e 'e2e/source-change-recheck.spec.ts'` then passed all three selected
  Chromium projects after the fix.

### Checks on the final application tree

- `just format` passed before the final complete test runs.
- `just test` passed with 884 backend tests and 311 frontend tests across
  71 frontend test files. Python lint, format checks, type checks across 71 source
  files, and API contract checks passed. Frontend build and lint also passed.
  Log: `/tmp/sangam-audit-second-test.log`.
- `just test-e2e-webkit-local` passed with 433 passed and 89 skipped in 11.7 minutes.
  This delegates to `just test-e2e` with isolated compatibility libraries. The initial
  plain run failed because host WebKit libraries were missing.
  `just setup-webkit-local` resolved that without modifying the host system.
  No tracked screenshot baselines changed. Log: `/tmp/sangam-audit-second-e2e.log`.
- The citation workflow passed on desktop Chromium at 1440x900, narrow desktop
  Chromium at 390x844 with a fine pointer, and Pixel 7 touch-mobile Chromium at
  390x844 with `isMobile` and `hasTouch`. I inspected the three
  `updated-source-citation.png` images in their `frontend/test-results/` directories.
  The source link and preview text remain readable within the viewport. This change
  does not alter CSS, breakpoints, geometry, or scrolling. Breakpoint-adjacent,
  landscape, and 320px layout checks were therefore not selected. The configured
  WebKit suites do not select this citation workflow. That workflow remains
  unverified in mobile Safari and on physical devices.
- `just verify-input-failures` passed against isolated services. It includes the
  original URL, publication, CLI, and retention checks, plus unreadable backups,
  attachment restoration, and malformed provider responses. Evidence:
  `artifacts/verify-sangam/20261109210420_3743/input-failures.json`.
- `just verify-behavior 8897 3 1` passed. SQLite checks confirmed 1,014 persisted
  writes and matching searches while live chat streaming completed without reported
  errors. The recipe also passed 83 policy/integration tests and one live chat
  evaluation. This is a smoke check, not a performance comparison or a complete
  model evaluation. Evidence: `artifacts/verify-sangam/20261109212449_15776/`.
- `just verify-restore-drill` passed, including a fresh boot from restored storage.
  Evidence: `artifacts/restore-drill/1794288358.json`.
- `just test-docs`, `just anti-slop`, and `git diff --check` passed after updating
  this report.

### Other checks and limits

`just check-distribution` passed in the first pass, including dependency
vulnerability policies. `just validate-compose` also passed for development and
production configurations. They were not rerun after the second pass. Dependency
and compose files were unchanged.

The full live chat evaluation matrix, assignment restart verification, container
build and smoke test, and production deployment checks were not run. The browser
suite's skipped cases were not verified. Dedicated live reproductions for the
remaining review items are still outstanding. The source-budget regression uses
SQLite integration tests, not a live model that retrieved 50 sources.

Repeatable regression entry points include `tests/test_audit_regressions.py`,
`tests/test_chat_web_research.py`, `frontend/e2e/source-change-recheck.spec.ts`, and
`just verify-input-failures`. Verification instances were stopped after use.
