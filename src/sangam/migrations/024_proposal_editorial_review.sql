CREATE TABLE chat_run_sources (
    source_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES chat_runs(run_id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES documents(document_id),
    revision_id TEXT NOT NULL DEFAULT '',
    page_number INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(run_id, document_id, revision_id, page_number)
);

CREATE INDEX chat_run_sources_run_idx
    ON chat_run_sources(run_id);

ALTER TABLE chat_proposals
    ADD COLUMN run_id TEXT REFERENCES chat_runs(run_id) ON DELETE SET NULL;

ALTER TABLE chat_proposals
    ADD COLUMN rationale TEXT;

ALTER TABLE chat_proposals
    ADD COLUMN judgment_needed TEXT;

ALTER TABLE chat_proposals
    ADD COLUMN citations_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE chat_proposals
    ADD COLUMN sources_retrieved_json TEXT NOT NULL DEFAULT '[]';

CREATE INDEX chat_proposals_run_idx
    ON chat_proposals(run_id);
