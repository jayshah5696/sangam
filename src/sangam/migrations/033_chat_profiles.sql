CREATE TABLE chat_profile_entries (
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    scope TEXT NOT NULL,
    content TEXT NOT NULL,
    version INTEGER NOT NULL,
    PRIMARY KEY (actor_id, scope)
);
CREATE TABLE chat_profile_turns (
    context_id TEXT PRIMARY KEY REFERENCES chat_turn_contexts(context_id) ON DELETE CASCADE,
    profile_json TEXT NOT NULL
);
CREATE TABLE chat_profile_mutation_results (
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    idempotency_key TEXT NOT NULL,
    response_json TEXT NOT NULL,
    PRIMARY KEY (actor_id, idempotency_key)
);
ALTER TABLE mutation_idempotency_keys RENAME TO mutation_keys_before_profiles;
CREATE TABLE mutation_idempotency_keys (
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    idempotency_key TEXT NOT NULL,
    operation TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    resource_type TEXT NOT NULL CHECK (resource_type IN (
        'tag', 'folder', 'backup', 'document', 'publication',
        'publication_revision', 'pdf_document', 'annotation', 'project', 'comment', 'chat_profile'
    )),
    resource_id TEXT NOT NULL,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (actor_id, idempotency_key)
);
INSERT INTO mutation_idempotency_keys SELECT * FROM mutation_keys_before_profiles;
DROP TABLE mutation_keys_before_profiles;
