CREATE TABLE html_javascript_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    version INTEGER NOT NULL DEFAULT 1,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

INSERT INTO html_javascript_settings(id, enabled, version, updated_by, updated_at)
SELECT 1, 1, 1, 'system:migration', strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
