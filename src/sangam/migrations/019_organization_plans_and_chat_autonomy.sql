CREATE TABLE organization_plan_executions (
    execution_id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    idempotency_key TEXT NOT NULL,
    argument_digest TEXT NOT NULL,
    normalized_plan_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'failed')),
    result_json TEXT,
    next_operation INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(actor_id, idempotency_key)
);

ALTER TABLE chat_model_settings
    ADD COLUMN autonomy_mode TEXT NOT NULL DEFAULT 'review'
    CHECK (autonomy_mode IN ('review', 'workspace'));

ALTER TABLE chat_runs ADD COLUMN cancel_requested_at TEXT;
