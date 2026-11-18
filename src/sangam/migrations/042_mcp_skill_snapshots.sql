CREATE TABLE mcp_skill_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    superseded_at TEXT
);
CREATE UNIQUE INDEX mcp_skill_current ON mcp_skill_snapshots(skill_id)
    WHERE superseded_at IS NULL;
CREATE INDEX mcp_skill_expiry ON mcp_skill_snapshots(superseded_at);
