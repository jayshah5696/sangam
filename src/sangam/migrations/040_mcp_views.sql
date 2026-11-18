CREATE TABLE mcp_document_views (
    workspace_id TEXT PRIMARY KEY REFERENCES mcp_workspaces(workspace_id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    location_json TEXT NOT NULL
);
CREATE TABLE mcp_layout_views (
    layout_id TEXT PRIMARY KEY REFERENCES mcp_layouts(layout_id) ON DELETE CASCADE,
    comparison_workspace_id TEXT REFERENCES mcp_workspaces(workspace_id) ON DELETE SET NULL
);
