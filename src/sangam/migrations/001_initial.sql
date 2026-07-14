CREATE TABLE actors (
    actor_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'client', 'system')),
    created_at TEXT NOT NULL
);

CREATE TABLE documents (
    document_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content_type TEXT NOT NULL CHECK (content_type = 'text/markdown'),
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
    FOREIGN KEY (current_revision_id) REFERENCES revisions(revision_id)
);

CREATE TABLE revisions (
    revision_id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(document_id),
    parent_revision_id TEXT REFERENCES revisions(revision_id),
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    operation TEXT NOT NULL
        CHECK (operation IN ('create', 'update', 'materialize', 'move', 'delete', 'restore', 'reconcile')),
    summary TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX revisions_document_created_idx
    ON revisions(document_id, created_at DESC);

CREATE TABLE idempotency_keys (
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    idempotency_key TEXT NOT NULL,
    operation TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    document_id TEXT NOT NULL REFERENCES documents(document_id),
    revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (actor_id, idempotency_key)
);

CREATE TABLE reconciliation_conflicts (
    conflict_id TEXT PRIMARY KEY,
    conflict_type TEXT NOT NULL
        CHECK (conflict_type IN ('unexpected_hash', 'possible_move', 'unknown_file')),
    document_id TEXT REFERENCES documents(document_id),
    path TEXT NOT NULL,
    candidate_path TEXT,
    expected_hash TEXT,
    actual_hash TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    created_at TEXT NOT NULL,
    resolved_at TEXT
);

CREATE UNIQUE INDEX reconciliation_open_conflict_idx
    ON reconciliation_conflicts(conflict_type, ifnull(document_id, ''), path, ifnull(candidate_path, ''))
    WHERE status = 'open';
