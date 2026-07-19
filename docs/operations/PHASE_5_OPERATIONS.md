# Phase 5 operations

## Storage and limits

PDF files are stored under `SANGAM_WORKSPACE_ROOT` and included in the normal
workspace backup artifact. SQLite stores their stable IDs, hashes, sizes,
relationships, extraction state, page text, annotations, and annotation
events.

The default import limit is 100 MB. Override it only after checking available
workspace, backup, and temporary-file capacity:

```bash
SANGAM_MAX_PDF_BYTES=250000000
```

The configured value accepts 1 KB through 1 GB. The limit is enforced before
the atomic workspace write.

## Import a PDF

The browser welcome screen is the normal human import path. The CLI sends the
same raw `application/pdf` request:

```bash
sangam pdf-import paper.pdf \
  --title "Research paper" \
  --path research/paper.pdf
```

The result includes the stable Document ID, source hash, extraction state, and
workspace path. Keep the returned ID in citations; paths may be human-readable
labels but are not identity.

Wait for `pdf_extraction_status` to become `ready`, then inspect or search page
text:

```bash
sangam read DOCUMENT_ID --json
sangam pdf-pages DOCUMENT_ID
sangam pdf-pages DOCUMENT_ID --query "specific phrase"
sangam annotations DOCUMENT_ID --query evidence
```

## Extraction failure and retry

An extraction failure leaves the PDF readable. Review
`pdf_extraction_error` in the Document response, confirm that the PDF opens in
another reader, and retry from the browser or API:

```bash
curl --fail --request POST \
  http://127.0.0.1:8000/api/v1/pdfs/DOCUMENT_ID/extract
```

Sangam resumes `pending` and interrupted `processing` extraction records at
startup. Repeated failure usually indicates damaged PDF structure, encryption,
or unsupported content. Phase 5 does not run OCR; an image-only PDF may extract
successfully with empty page text.

## Verify immutable source bytes

Compare the API hash and workspace hash:

```bash
sangam read DOCUMENT_ID --json
sha256sum data/workspace/research/paper.pdf
```

On macOS, use:

```bash
shasum -a 256 data/workspace/research/paper.pdf
```

The value must equal both `content_hash` and `file_hash`. The authorized byte
endpoint verifies the hash before serving any full or partial response.

## Import a replacement

Never copy replacement bytes over an imported PDF. Import them as a new
Document and record the relationship:

```bash
sangam pdf-import revised-paper.pdf \
  --title "Research paper, revised" \
  --path research/revised-paper.pdf \
  --supersedes ORIGINAL_DOCUMENT_ID
```

The original file, Document, annotations, and citations remain unchanged. New
research belongs to the replacement Document unless the user deliberately
links back to an older annotation.

## Reconciliation and recovery

If a PDF changes outside Sangam, startup reconciliation records an
`unexpected_hash` conflict. Do not choose an accept-disk workflow: binary
replacement in place is forbidden. Preserve the changed file separately,
restore the original from a verified backup, or import the changed bytes at a
new path with `--supersedes`.

If a PDF is missing, Sangam cannot reconstruct it from SQLite because binary
bytes are intentionally not duplicated there. Restore the workspace file and
database from the same verified backup set. Then restart Sangam and confirm:

- The Document `content_hash` matches the restored file.
- The PDF reader opens every representative page.
- Extracted search results still navigate to the right page.
- Existing annotation links resolve against the same Document ID.

The standard backup command covers both SQLite and workspace content:

```bash
just docker-smoke
sangam read DOCUMENT_ID --json
```

Use the Phase 2 backup and restore runbook for a complete restore drill.

## Incident response

For suspected PDF tampering:

1. Stop Sangam so the workspace evidence does not change.
2. Record the current file SHA-256 and compare it with SQLite `content_hash`.
3. Preserve the suspect bytes outside the workspace.
4. Restore the original PDF from a verified backup.
5. Restart and confirm reconciliation returns clean.
6. Import the suspect or legitimate replacement as a new Document only after
   review.
7. Review annotation events and operation activity for unexpected actors.

Do not resolve tampering by editing `content_hash`, `file_hash`, annotation
geometry, or `supersedes_document_id` directly in SQLite.
