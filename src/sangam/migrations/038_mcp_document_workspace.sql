CREATE TABLE mcp_workspaces (
    workspace_id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    document_id TEXT NOT NULL REFERENCES documents(document_id),
    base_revision_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    draft TEXT,
    updated_at TEXT NOT NULL
);
CREATE INDEX mcp_workspaces_actor ON mcp_workspaces(actor_id);

CREATE TABLE mcp_executions (
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    execution_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    result_json TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    PRIMARY KEY (actor_id, execution_key)
);
CREATE TABLE mcp_execution_documents (
    actor_id TEXT NOT NULL,
    execution_key TEXT NOT NULL,
    document_id TEXT NOT NULL,
    capability TEXT NOT NULL DEFAULT 'read',
    PRIMARY KEY (actor_id, execution_key, document_id, capability),
    FOREIGN KEY (actor_id, execution_key) REFERENCES mcp_executions(actor_id, execution_key)
);
CREATE TABLE mcp_execution_writes (
    actor_id TEXT NOT NULL,
    execution_key TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    document_id TEXT NOT NULL,
    outcome TEXT NOT NULL DEFAULT 'unknown',
    PRIMARY KEY (actor_id, execution_key, operation_key),
    FOREIGN KEY (actor_id, execution_key) REFERENCES mcp_executions(actor_id, execution_key)
);
CREATE TABLE mcp_workspace_saves (
    actor_id TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    revision_id TEXT NOT NULL,
    PRIMARY KEY (actor_id, operation_key)
);
