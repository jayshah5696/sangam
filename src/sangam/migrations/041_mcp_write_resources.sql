ALTER TABLE mcp_execution_writes ADD COLUMN resource_id TEXT;
ALTER TABLE mcp_execution_writes ADD COLUMN resource_type TEXT NOT NULL DEFAULT 'document';
UPDATE mcp_execution_writes SET resource_id = document_id;
