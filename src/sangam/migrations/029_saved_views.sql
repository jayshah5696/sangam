-- A saved view is a named search query and filters for the whole workspace.
-- Opening one re-runs the search, so only the query is stored, never results.
CREATE TABLE saved_views (
    view_id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    filters_json TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
