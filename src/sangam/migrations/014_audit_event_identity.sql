-- sangam:foreign-keys-off
CREATE TABLE operation_events_new (
    event_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
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

INSERT INTO operation_events_new(
    event_id, operation_id, actor_id, token_id, action, resource_type,
    resource_id, path, outcome, error_code, revision_id, detail_json, created_at
)
SELECT
    operation_id, operation_id, actor_id, token_id, action, resource_type,
    resource_id, path, outcome, error_code, revision_id, detail_json, created_at
FROM operation_events;

DROP TABLE operation_events;
ALTER TABLE operation_events_new RENAME TO operation_events;

CREATE INDEX operation_events_operation_created_idx
    ON operation_events(operation_id, created_at, event_id);

CREATE INDEX operation_events_actor_created_idx
    ON operation_events(actor_id, created_at DESC);

CREATE INDEX operation_events_outcome_created_idx
    ON operation_events(outcome, created_at DESC);

CREATE INDEX operation_events_revision_outcome_created_idx
    ON operation_events(revision_id, outcome, created_at, event_id);
