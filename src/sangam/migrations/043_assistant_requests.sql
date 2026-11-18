CREATE TABLE assistant_requests (
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    request_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    document_id TEXT REFERENCES documents(document_id),
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
    user_item_id TEXT,
    answer TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    PRIMARY KEY (actor_id, request_key)
);
CREATE UNIQUE INDEX assistant_requests_active_conversation ON assistant_requests(conversation_id)
    WHERE status = 'running';

-- Earlier turns did not record skill catalogs as sources. Their inventory
-- cannot establish that a narrower connection may read the generated answer.
UPDATE chat_runs SET sources_truncated = 1;

CREATE TABLE mcp_execution_chat_refs (
    actor_id TEXT NOT NULL,
    execution_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('request', 'conversation')),
    reference TEXT NOT NULL,
    PRIMARY KEY (actor_id, execution_key, kind, reference),
    FOREIGN KEY (actor_id, execution_key) REFERENCES mcp_executions(actor_id, execution_key)
);
