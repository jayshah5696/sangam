CREATE TABLE chat_threads (
    thread_id TEXT PRIMARY KEY,
    created_by TEXT NOT NULL REFERENCES actors(actor_id),
    document_id TEXT REFERENCES documents(document_id),
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX chat_threads_actor_updated_idx
    ON chat_threads(created_by, updated_at DESC, thread_id);

CREATE TABLE chat_thread_items (
    item_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES chat_threads(thread_id) ON DELETE CASCADE,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX chat_thread_items_thread_created_idx
    ON chat_thread_items(thread_id, created_at, item_id);

CREATE TABLE chat_attachments (
    attachment_id TEXT PRIMARY KEY,
    created_by TEXT NOT NULL REFERENCES actors(actor_id),
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE chat_proposals (
    proposal_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES chat_threads(thread_id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES documents(document_id),
    expected_revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
    content TEXT NOT NULL,
    summary TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'stale', 'dismissed')),
    applied_revision_id TEXT REFERENCES revisions(revision_id),
    created_at TEXT NOT NULL,
    applied_at TEXT
);

CREATE INDEX chat_proposals_thread_created_idx
    ON chat_proposals(thread_id, created_at DESC);
