ALTER TABLE documents ADD COLUMN category TEXT;
ALTER TABLE documents ADD COLUMN metadata_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE folders (
    folder_id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    category TEXT,
    metadata_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE tags (
    tag_id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    color TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE document_tags (
    document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(tag_id) ON DELETE CASCADE,
    PRIMARY KEY (document_id, tag_id)
);

CREATE TABLE folder_tags (
    folder_id TEXT NOT NULL REFERENCES folders(folder_id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(tag_id) ON DELETE CASCADE,
    PRIMARY KEY (folder_id, tag_id)
);

CREATE TABLE metadata_events (
    event_id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('document', 'folder', 'tag')),
    entity_id TEXT NOT NULL,
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    operation TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX metadata_events_entity_idx
    ON metadata_events(entity_type, entity_id, created_at DESC);

CREATE VIRTUAL TABLE document_search USING fts5(
    document_id UNINDEXED,
    title,
    path,
    content,
    tags,
    category,
    tokenize = 'unicode61 remove_diacritics 2'
);
