# Search Workspace

Search workspace allows users and agents to query across document titles, Markdown bodies, categories, and tags using SQLite FTS5 full-text indexing with highlighted snippets.

## Sub-features

- `search-cli`: Full-text query via `sangam search <query>`.
- `search-api`: REST search via `GET /api/v1/search?q=<query>`.
- `search-snippet`: Verification that matching keywords are wrapped in highlight markers (e.g. `[[token]]`).

## How to get to it (user POV)

- Run `sangam search <terms>` in terminal.
- Call `GET /api/v1/search?q=<terms>` over HTTP.
- Use the search bar in the Sangam browser sidebar.

## Driving it with control-sangam

Preconditions:
- Instance is healthy via `./scripts/control-sangam.sh doctor`.
- Seeded document exists containing keyword `quantum_verifiable_proof`.

- **Seed Document:**
  ```bash
  ./scripts/control-sangam.sh cli create --title "Physics Notes" --content "Notes discussing quantum_verifiable_proof in distributed systems."
  ```

- **Execute Search:**
  ```bash
  ./scripts/control-sangam.sh cli search "quantum_verifiable_proof"
  ```
  Expected: Non-empty JSON array with `Physics Notes`, and `search_snippet` containing `"[[quantum_verifiable_proof]]"`.

- **Verify Negative Search:**
  ```bash
  ./scripts/control-sangam.sh cli search "nonexistent_token_xyz"
  ```
  Expected: Empty JSON array `[]`.

## Gotchas

- FTS5 indexing happens synchronously on document create/update. If search does not return immediately, check SQLite trigger/table status.
- Exact multi-word phrases should be quoted.
