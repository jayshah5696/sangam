ALTER TABLE assistant_requests ADD COLUMN workspace_id TEXT REFERENCES mcp_workspaces(workspace_id) ON DELETE SET NULL;
ALTER TABLE assistant_requests ADD COLUMN context_json TEXT NOT NULL DEFAULT '[]';
CREATE INDEX assistant_requests_workspace ON assistant_requests(actor_id, workspace_id, created_at DESC);

ALTER TABLE mcp_execution_writes RENAME TO mcp_writes_before_creation;
CREATE TABLE mcp_execution_writes (
    actor_id TEXT NOT NULL,
    execution_key TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    document_id TEXT,
    outcome TEXT NOT NULL DEFAULT 'unknown',
    resource_id TEXT,
    resource_type TEXT NOT NULL DEFAULT 'document',
    PRIMARY KEY (actor_id, execution_key, operation_key),
    FOREIGN KEY (actor_id, execution_key) REFERENCES mcp_executions(actor_id, execution_key)
);
INSERT INTO mcp_execution_writes SELECT * FROM mcp_writes_before_creation;
DROP TABLE mcp_writes_before_creation;
