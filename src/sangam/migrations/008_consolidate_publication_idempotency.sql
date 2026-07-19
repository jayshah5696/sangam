ALTER TABLE mutation_idempotency_keys RENAME TO mutation_idempotency_keys_legacy;

CREATE TABLE mutation_idempotency_keys (
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    idempotency_key TEXT NOT NULL,
    operation TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    resource_type TEXT NOT NULL CHECK (
        resource_type IN (
            'tag', 'folder', 'backup', 'document', 'publication', 'publication_revision'
        )
    ),
    resource_id TEXT NOT NULL,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (actor_id, idempotency_key)
);

INSERT INTO mutation_idempotency_keys(
    actor_id, idempotency_key, operation, request_hash,
    resource_type, resource_id, completed_at, created_at
)
SELECT
    actor_id, idempotency_key, operation, request_hash,
    resource_type, resource_id, completed_at, created_at
FROM mutation_idempotency_keys_legacy;

INSERT INTO mutation_idempotency_keys(
    actor_id, idempotency_key, operation, request_hash,
    resource_type, resource_id, completed_at, created_at
)
SELECT
    actor_id,
    idempotency_key,
    operation,
    request_hash,
    CASE
        WHEN operation = 'document_trust' THEN 'document'
        WHEN operation = 'expose_revision' THEN 'publication_revision'
        ELSE 'publication'
    END,
    resource_id,
    created_at,
    created_at
FROM phase_four_idempotency_keys;

DROP TABLE mutation_idempotency_keys_legacy;
DROP TABLE phase_four_idempotency_keys;
