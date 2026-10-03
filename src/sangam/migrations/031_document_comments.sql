CREATE TABLE document_comments (
    comment_id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
    revision_id TEXT NOT NULL REFERENCES revisions(revision_id) ON DELETE CASCADE,
    exact TEXT NOT NULL,
    prefix TEXT NOT NULL DEFAULT '',
    suffix TEXT NOT NULL DEFAULT '',
    "start" INTEGER NOT NULL,
    "end" INTEGER NOT NULL,
    body TEXT NOT NULL,
    resolved_at TEXT,
    created_by TEXT NOT NULL REFERENCES actors(actor_id),
    created_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX document_comments_document_idx
    ON document_comments(document_id, resolved_at, created_at);

CREATE INDEX document_comments_revision_idx
    ON document_comments(revision_id);

ALTER TABLE mutation_idempotency_keys RENAME TO mutation_idempotency_keys_before_comments;
CREATE TABLE mutation_idempotency_keys (
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    idempotency_key TEXT NOT NULL,
    operation TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    resource_type TEXT NOT NULL CHECK (resource_type IN (
        'tag', 'folder', 'backup', 'document', 'publication',
        'publication_revision', 'pdf_document', 'annotation', 'project', 'comment'
    )),
    resource_id TEXT NOT NULL,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (actor_id, idempotency_key)
);
INSERT INTO mutation_idempotency_keys SELECT * FROM mutation_idempotency_keys_before_comments;
DROP TABLE mutation_idempotency_keys_before_comments;
