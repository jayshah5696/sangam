DROP TABLE document_search;

CREATE VIRTUAL TABLE document_search USING fts5(
    document_id UNINDEXED,
    title,
    path,
    content,
    tags,
    category,
    authors,
    revision_summaries,
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE ignored_workspace_files (
    path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    ignored_at TEXT NOT NULL
);
