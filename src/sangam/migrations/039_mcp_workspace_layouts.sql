CREATE TABLE mcp_layouts (
    layout_id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    version INTEGER NOT NULL DEFAULT 1,
    active_workspace_id TEXT NOT NULL REFERENCES mcp_workspaces(workspace_id),
    updated_at TEXT NOT NULL
);
CREATE TABLE mcp_layout_documents (
    layout_id TEXT NOT NULL REFERENCES mcp_layouts(layout_id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL UNIQUE REFERENCES mcp_workspaces(workspace_id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (layout_id, workspace_id),
    UNIQUE (layout_id, position)
);
INSERT INTO mcp_layouts (layout_id, actor_id, active_workspace_id, updated_at)
SELECT 'mcpl_' || workspace_id, actor_id, workspace_id, updated_at FROM mcp_workspaces;
INSERT INTO mcp_layout_documents (layout_id, workspace_id, position)
SELECT 'mcpl_' || workspace_id, workspace_id, 0 FROM mcp_workspaces;
