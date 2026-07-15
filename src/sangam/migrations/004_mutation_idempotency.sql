CREATE TABLE mutation_idempotency_keys (
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    idempotency_key TEXT NOT NULL,
    operation TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    resource_type TEXT NOT NULL CHECK (resource_type IN ('tag', 'folder', 'backup')),
    resource_id TEXT NOT NULL,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (actor_id, idempotency_key)
);

CREATE INDEX revisions_actor_document_idx
    ON revisions(actor_id, document_id);
