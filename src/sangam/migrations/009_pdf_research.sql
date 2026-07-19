-- sangam:foreign-keys-off

CREATE TABLE documents_phase_five (
    document_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content_type TEXT NOT NULL
        CHECK (content_type IN ('text/markdown', 'text/html', 'application/pdf')),
    path TEXT UNIQUE,
    current_revision_id TEXT,
    content_hash TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    materialization_state TEXT NOT NULL
        CHECK (materialization_state IN ('none', 'pending', 'clean', 'conflict')),
    file_hash TEXT,
    deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    created_by TEXT NOT NULL REFERENCES actors(actor_id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    category TEXT,
    metadata_version INTEGER NOT NULL DEFAULT 0,
    trust_level TEXT NOT NULL DEFAULT 'untrusted'
        CHECK (trust_level IN ('untrusted', 'trusted_interactive')),
    trust_version INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (current_revision_id) REFERENCES revisions(revision_id)
);

INSERT INTO documents_phase_five
SELECT * FROM documents;

DROP TABLE documents;
ALTER TABLE documents_phase_five RENAME TO documents;

CREATE INDEX documents_deleted_updated_idx
    ON documents(deleted, updated_at DESC, document_id);
CREATE INDEX documents_category_idx
    ON documents(category COLLATE NOCASE);

CREATE TABLE pdf_documents (
    document_id TEXT PRIMARY KEY REFERENCES documents(document_id) ON DELETE CASCADE,
    page_count INTEGER,
    mime_type TEXT NOT NULL DEFAULT 'application/pdf',
    extraction_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (extraction_status IN ('pending', 'processing', 'ready', 'failed')),
    extraction_error TEXT,
    extraction_attempts INTEGER NOT NULL DEFAULT 0,
    extracted_at TEXT,
    supersedes_document_id TEXT REFERENCES documents(document_id),
    imported_at TEXT NOT NULL
);

CREATE INDEX pdf_documents_extraction_status_idx
    ON pdf_documents(extraction_status, imported_at);
CREATE INDEX pdf_documents_supersedes_idx
    ON pdf_documents(supersedes_document_id);

CREATE TABLE pdf_pages (
    document_id TEXT NOT NULL REFERENCES pdf_documents(document_id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL CHECK (page_number >= 1),
    text TEXT NOT NULL,
    PRIMARY KEY (document_id, page_number)
);

CREATE TABLE annotations (
    annotation_id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES pdf_documents(document_id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL CHECK (page_number >= 1),
    annotation_type TEXT NOT NULL CHECK (
        annotation_type IN (
            'text_highlight', 'area_highlight', 'comment', 'page_note',
            'bookmark', 'citation_marker'
        )
    ),
    selected_text TEXT,
    note TEXT,
    geometry_json TEXT NOT NULL DEFAULT '[]',
    tags_json TEXT NOT NULL DEFAULT '[]',
    color TEXT NOT NULL DEFAULT '#f0c75e',
    version INTEGER NOT NULL DEFAULT 1,
    deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    created_by TEXT NOT NULL REFERENCES actors(actor_id),
    updated_by TEXT NOT NULL REFERENCES actors(actor_id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX annotations_document_page_idx
    ON annotations(document_id, page_number, updated_at, annotation_id);

CREATE TABLE annotation_events (
    event_id TEXT PRIMARY KEY,
    annotation_id TEXT NOT NULL REFERENCES annotations(annotation_id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES pdf_documents(document_id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
    version INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX annotation_events_annotation_version_idx
    ON annotation_events(annotation_id, version DESC);

ALTER TABLE mutation_idempotency_keys RENAME TO mutation_idempotency_keys_phase_four;

CREATE TABLE mutation_idempotency_keys (
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    idempotency_key TEXT NOT NULL,
    operation TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    resource_type TEXT NOT NULL CHECK (
        resource_type IN (
            'tag', 'folder', 'backup', 'document', 'publication',
            'publication_revision', 'pdf_document', 'annotation'
        )
    ),
    resource_id TEXT NOT NULL,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (actor_id, idempotency_key)
);

INSERT INTO mutation_idempotency_keys
SELECT * FROM mutation_idempotency_keys_phase_four;

DROP TABLE mutation_idempotency_keys_phase_four;
