CREATE TABLE karakeep_imports (
    import_id TEXT PRIMARY KEY,
    bookmark_id TEXT NOT NULL UNIQUE,
    document_id TEXT UNIQUE REFERENCES documents(document_id),
    status TEXT NOT NULL CHECK (
        status IN ('importing', 'current', 'review_required', 'failed')
    ),
    accepted_snapshot_id TEXT,
    pending_snapshot_id TEXT,
    last_error TEXT,
    last_attempt_at TEXT NOT NULL,
    last_success_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX karakeep_imports_status_updated_idx
    ON karakeep_imports(status, updated_at DESC);

CREATE TABLE karakeep_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    import_id TEXT NOT NULL REFERENCES karakeep_imports(import_id) ON DELETE CASCADE,
    source_url TEXT,
    title TEXT NOT NULL,
    author TEXT,
    source_created_at TEXT,
    source_modified_at TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    assets_json TEXT NOT NULL DEFAULT '[]',
    source_payload_json TEXT NOT NULL,
    source_html TEXT NOT NULL DEFAULT '',
    extracted_markdown TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(import_id, content_hash)
);

CREATE INDEX karakeep_snapshots_import_created_idx
    ON karakeep_snapshots(import_id, created_at DESC);

