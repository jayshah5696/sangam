ALTER TABLE actor_tokens ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE actor_token_events (
    event_id TEXT PRIMARY KEY,
    token_id TEXT NOT NULL REFERENCES actor_tokens(token_id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    operation TEXT NOT NULL CHECK (operation IN ('update')),
    version INTEGER NOT NULL,
    before_json TEXT NOT NULL,
    after_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX actor_token_events_token_created_idx
    ON actor_token_events(token_id, created_at DESC, event_id DESC);

CREATE INDEX operation_events_created_idx
    ON operation_events(created_at DESC, event_id DESC);
