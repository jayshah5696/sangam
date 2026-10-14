ALTER TABLE mutation_idempotency_keys RENAME TO mutation_keys_before_skills;
CREATE TABLE mutation_idempotency_keys (
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    idempotency_key TEXT NOT NULL,
    operation TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    resource_type TEXT NOT NULL CHECK (resource_type IN (
        'tag', 'folder', 'backup', 'document', 'publication',
        'publication_revision', 'pdf_document', 'annotation', 'project', 'comment', 'chat_profile', 'chat_skill'
    )),
    resource_id TEXT NOT NULL,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (actor_id, idempotency_key)
);
INSERT INTO mutation_idempotency_keys SELECT * FROM mutation_keys_before_skills;
DROP TABLE mutation_keys_before_skills;

CREATE TABLE chat_skills (
    skill_id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    project_id TEXT REFERENCES projects(project_id) ON DELETE CASCADE,
    skill_name TEXT NOT NULL,
    description TEXT NOT NULL,
    has_scripts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (document_id)
);

CREATE INDEX chat_skills_actor_project_idx ON chat_skills(actor_id, project_id);

CREATE TABLE chat_skill_reads (
    context_id TEXT NOT NULL REFERENCES chat_turn_contexts(context_id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
    resource_document_id TEXT NOT NULL DEFAULT '',
    resource_revision_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (context_id, skill_id, resource_document_id)
);

CREATE TABLE chat_skill_mutation_results (
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    idempotency_key TEXT NOT NULL,
    response_json TEXT NOT NULL,
    PRIMARY KEY (actor_id, idempotency_key)
);
