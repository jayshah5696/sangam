# Contributing to Sangam

This document describes the branch, commit, verification, and release process
for Sangam. The goal is that every change lands on `main` in a state a
self-hoster can pull safely, and that cutting a container release is a single
command.

## TL;DR

```bash
git switch -c feat/my-change      # branch off main
# ...work...
just check                        # run every pre-push check
git commit -m "feat: my change"   # conventional commit
git push -u origin feat/my-change # open a PR
# after review + merge to main:
just release-dry 0.2.0            # preview the version bump + changelog
just release 0.2.0                # tag v0.2.0 and publish to GHCR
```

## Branching

- `main` is the release trunk. Every commit on `main` is buildable and gets a
  `:main` and `:sha-<short>` image pushed to
  `ghcr.io/jayshah5696/sangam` by `.github/workflows/docker-publish.yml`.
- Feature branches: `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `chore/<slug>`.
- Rebase onto `main` (not merge) to keep history linear before opening a PR.
- Never force-push `main`. Force-push feature branches only if you own them.

## Commit style

We use [Conventional Commits](https://www.conventionalcommits.org/) so
`git-cliff` can group changes into `CHANGELOG.md`:

| Prefix     | Meaning                                          | Section       |
| ---------- | ------------------------------------------------ | ------------- |
| `feat:`    | User-visible new capability                      | Added         |
| `fix:`     | Bug fix                                          | Fixed         |
| `perf:`    | Performance improvement                          | Performance   |
| `refactor:`| Internal restructuring, no behaviour change      | Changed       |
| `docs:`    | Documentation only                               | Documentation |
| `test:`    | Test-only changes                                | Tests         |
| `chore:`   | Housekeeping (deps, config)                      | Chore         |
| `ci:`      | CI/CD changes                                    | CI            |
| `build:`   | Build system, Dockerfile, packaging              | Build         |

Breaking changes: append `!` (e.g. `feat!: remove legacy endpoint`) or add a
`BREAKING CHANGE:` footer. These get flagged in the changelog and require a
major-version bump.

Enable the local commit-message hook once per clone so mistakes are caught
before push:

```bash
git config core.hooksPath scripts/git-hooks
```

## Before pushing

Run the full check suite. It matches CI, so a green run here means a green PR:

```bash
just check
```

That runs, in order: `ruff check`, `ruff format --check`, `pytest`, frontend
format/build/lint/test, and the doc verifier. When you also change the
Dockerfile, dependencies, or anything under `src/`, add a container build:

```bash
just check-docker    # runs just check, then rebuilds the image
just docker-smoke    # end-to-end smoke against the built image (slower)
```

Individual recipes remain available for tight loops: `just test-backend`,
`just test-frontend`, `just test-docs`, `just format`.

## Pull requests

- One logical change per PR. Split refactors from behaviour changes.
- PR title uses the same Conventional Commit prefix as the squashed commit.
- Fill in the PR description with **what** changed and **why**; the diff shows
  the how.
- Merge strategy: **squash-and-merge** so `main` reflects one commit per PR and
  the changelog stays tidy.
- CI must be green (`ci.yml`) before merge. Do not merge with red required
  checks; investigate rather than re-running until flaky.

## Releases

Releases are cut from `main` after the PRs you want to ship are merged.

### Version scheme

Semantic Versioning: `MAJOR.MINOR.PATCH`.

- **Patch** (`0.1.0` → `0.1.1`): fixes only, no new features, no API changes.
- **Minor** (`0.1.0` → `0.2.0`): additive features, backwards-compatible.
- **Major** (`0.x.y` → `1.0.0`): breaking changes. While the project is `0.x`,
  minor bumps are allowed to carry breaking changes but call them out clearly.

### Cutting a release

```bash
git switch main
git pull --ff-only
just release-dry 0.2.0      # preview: bump + changelog diff, no commit
just release 0.2.0          # commit, tag v0.2.0, push branch + tag
```

`scripts/release.sh` will:

1. Refuse if the version isn't SemVer, the tag already exists, or the working
   tree is dirty.
2. Rewrite the `version = "..."` line in `pyproject.toml`.
3. Refresh `uv.lock`.
4. Regenerate `CHANGELOG.md` with `git-cliff` (installed on demand via `uvx`).
5. Create `chore(release): vX.Y.Z` and annotated tag `vX.Y.Z`.
6. Push the branch and tag to `origin`.

Pushing the tag triggers `docker-publish.yml`, which builds the multi-arch
image, signs it with cosign, generates an SBOM, and publishes:

- `ghcr.io/jayshah5696/sangam:0.2.0`
- `ghcr.io/jayshah5696/sangam:0.2`
- `ghcr.io/jayshah5696/sangam:latest`

### After the release lands

- Check the workflow run: `just release-status` (uses `gh run list`).
- Verify the image signature: `just verify-image 0.2.0`.
- Draft a GitHub Release from the pushed tag if you want to add narrative
  notes on top of the auto-generated changelog.

### Hotfixes

- Branch from the tag: `git switch -c fix/urgent v0.2.0`.
- Apply the fix, open a PR against `main`, merge.
- `just release 0.2.1` from `main` (once the fix is in).

If `main` has already moved past the point you can safely release from, cherry-
pick the fix onto a `release/0.2` branch, run `just release` from there.

## Container images

- `main` and every commit produce `:main` and `:sha-<short>` — safe for
  staging, do not pin in production.
- Tags produce `:X.Y.Z`, `:X.Y`, `:latest`. Self-hosters should pin to at
  least `:X.Y` (or a digest for reproducibility).
- Every image is signed by GitHub Actions keyless via Sigstore. Verify with:

  ```bash
  just verify-image 0.2.0
  ```

## Environment expectations

- Python 3.13+, managed by `uv` (`uv sync`).
- Node 26+ for the frontend, `npm ci` inside `frontend/`.
- Docker with buildx for local image builds and the smoke test.
- `gh` CLI for release status and PR management.
- `cosign` (optional) to verify published images locally.

## Security-sensitive changes

- Anything touching auth, token issuance, trusted-preview HMAC, or SQLite
  migrations requires a second reviewer and a note in the PR body.
- Never commit secrets. `SANGAM_PREVIEW_HMAC_SECRET` in production must be a
  freshly generated random value, not the development default.
- Dependency bumps in `pyproject.toml` or `frontend/package.json` must be
  accompanied by `uv lock` / `npm install` in the same commit so the lockfile
  stays in sync.
