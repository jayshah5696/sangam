ALTER TABLE actors ADD COLUMN identity_kind TEXT NOT NULL DEFAULT 'human'
    CHECK (identity_kind IN ('human', 'agent', 'integration', 'client', 'system'));

UPDATE actors
SET identity_kind = CASE actor_type
    WHEN 'human' THEN 'human'
    WHEN 'system' THEN 'system'
    ELSE 'client'
END;

CREATE TABLE actor_tokens (
    token_id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL REFERENCES actors(actor_id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    revoked_at TEXT,
    last_used_at TEXT,
    rotated_from_token_id TEXT REFERENCES actor_tokens(token_id),
    CHECK (length(label) BETWEEN 1 AND 120),
    CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX actor_tokens_actor_created_idx
    ON actor_tokens(actor_id, created_at DESC);

CREATE TABLE token_scopes (
    token_id TEXT NOT NULL REFERENCES actor_tokens(token_id) ON DELETE CASCADE,
    capability TEXT NOT NULL CHECK (
        capability IN ('read', 'search', 'create', 'update', 'move', 'tag', 'restore', 'delete')
    ),
    path_prefix TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (token_id, capability, path_prefix)
);

CREATE TABLE operation_events (
    operation_id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    token_id TEXT REFERENCES actor_tokens(token_id),
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    path TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'denied', 'conflict', 'failed')),
    error_code TEXT,
    revision_id TEXT REFERENCES revisions(revision_id),
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE INDEX operation_events_actor_created_idx
    ON operation_events(actor_id, created_at DESC);

CREATE INDEX operation_events_outcome_created_idx
    ON operation_events(outcome, created_at DESC);
