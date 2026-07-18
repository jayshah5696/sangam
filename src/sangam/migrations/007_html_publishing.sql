PRAGMA defer_foreign_keys = ON;

CREATE TABLE documents_phase_four (
    document_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content_type TEXT NOT NULL CHECK (content_type IN ('text/markdown', 'text/html')),
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

INSERT INTO documents_phase_four(
    document_id, title, content_type, path, current_revision_id, content_hash,
    size_bytes, materialization_state, file_hash, deleted, created_by,
    created_at, updated_at, category, metadata_version
)
SELECT
    document_id, title, content_type, path, current_revision_id, content_hash,
    size_bytes, materialization_state, file_hash, deleted, created_by,
    created_at, updated_at, category, metadata_version
FROM documents;

DROP TABLE documents;
ALTER TABLE documents_phase_four RENAME TO documents;

CREATE INDEX documents_deleted_updated_idx
    ON documents(deleted, updated_at DESC, document_id);
CREATE INDEX documents_category_idx
    ON documents(category COLLATE NOCASE);

DROP TABLE token_scopes;
CREATE TABLE token_scopes (
    token_id TEXT NOT NULL REFERENCES actor_tokens(token_id) ON DELETE CASCADE,
    capability TEXT NOT NULL CHECK (
        capability IN (
            'read', 'search', 'create', 'update', 'move', 'tag', 'restore', 'delete', 'publish'
        )
    ),
    path_prefix TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (token_id, capability, path_prefix)
);

CREATE TABLE document_trust_events (
    event_id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    previous_level TEXT NOT NULL CHECK (previous_level IN ('untrusted', 'trusted_interactive')),
    next_level TEXT NOT NULL CHECK (next_level IN ('untrusted', 'trusted_interactive')),
    trust_version INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX document_trust_events_document_created_idx
    ON document_trust_events(document_id, created_at DESC);

CREATE TABLE publications (
    publication_id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL UNIQUE REFERENCES documents(document_id) ON DELETE CASCADE,
    slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
    access_policy TEXT NOT NULL CHECK (access_policy IN ('private', 'public', 'unlisted')),
    version INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_by TEXT NOT NULL REFERENCES actors(actor_id),
    updated_by TEXT NOT NULL REFERENCES actors(actor_id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE publication_revision_exposures (
    publication_id TEXT NOT NULL REFERENCES publications(publication_id) ON DELETE CASCADE,
    revision_id TEXT NOT NULL REFERENCES revisions(revision_id) ON DELETE CASCADE,
    exposed_by TEXT NOT NULL REFERENCES actors(actor_id),
    exposed_at TEXT NOT NULL,
    PRIMARY KEY (publication_id, revision_id)
);

CREATE TABLE publication_tokens (
    token_id TEXT PRIMARY KEY,
    publication_id TEXT NOT NULL REFERENCES publications(publication_id) ON DELETE CASCADE,
    secret_hash TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES actors(actor_id),
    created_at TEXT NOT NULL,
    revoked_at TEXT
);

CREATE INDEX publication_tokens_publication_created_idx
    ON publication_tokens(publication_id, created_at DESC);

CREATE TABLE publication_events (
    event_id TEXT PRIMARY KEY,
    publication_id TEXT NOT NULL REFERENCES publications(publication_id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    operation TEXT NOT NULL CHECK (
        operation IN ('publish', 'update', 'unpublish', 'republish', 'expose_revision', 'rotate_token')
    ),
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE INDEX publication_events_publication_created_idx
    ON publication_events(publication_id, created_at DESC);

CREATE TABLE phase_four_idempotency_keys (
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    idempotency_key TEXT NOT NULL,
    operation TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (actor_id, idempotency_key)
);
