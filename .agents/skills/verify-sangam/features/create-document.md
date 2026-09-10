# Create a Document

Create document enables humans and agents to persist Markdown notes, specify initial titles, track authorship, and assign an immutable initial revision.

## Sub-features

- `doc-create-cli`: Creates a document via `sangam create` with title and content.
- `doc-create-api`: Creates a document via `POST /api/v1/documents` with explicit idempotency key.
- `doc-read-confirm`: Retrieves the created document by ID confirming exact content and hash match.

## How to get to it (user POV)

- Run `sangam create --title <title> --content <content>` in a terminal.
- Send `POST /api/v1/documents` with JSON body `{"title": "...", "content": "..."}`.
- Click `New document` in the browser navigation rail.

## Driving it with control-sangam

Preconditions:
- Sangam instance is healthy via `./scripts/control-sangam.sh doctor`.
- No document with title `Verification Note` exists.

- **CLI Creation:**
  Run:
  ```bash
  ./scripts/control-sangam.sh cli create --title "Verification Note" --content "Testing verifiable behavior"
  ```
  Expected: Exit code `0`, JSON response containing `document_id`, `current_revision_id`, `title: "Verification Note"`.

- **Second Read Verification:**
  Run:
  ```bash
  ./scripts/control-sangam.sh cli read <DOCUMENT_ID>
  ```
  Expected: Returns content matching `"Testing verifiable behavior"` and matching revision.

- **API Creation with Idempotency:**
  Run:
  ```bash
  ./scripts/control-sangam.sh api POST /documents '{"title":"API Spec","content":"Immutable spec content"}'
  ```
  Expected: HTTP 200/201 response with newly assigned `document_id`.

## Gotchas

- Sangam documents created without `--path` remain unmaterialized in database only. To verify file on disk, `--path` or `materialize` command is required.
- Mutations require `Idempotency-Key` header; `control-sangam.sh` automatically generates one for API commands.
