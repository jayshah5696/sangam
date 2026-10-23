CREATE TABLE chat_web_sources (
    source_id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES chat_runs(run_id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    published_at TEXT,
    retrieved_at TEXT NOT NULL,
    query TEXT NOT NULL,
    excerpt_hash TEXT,
    read_at TEXT,
    PRIMARY KEY (run_id, source_id),
    UNIQUE(run_id, url)
);

CREATE INDEX chat_web_sources_run_idx ON chat_web_sources(run_id);
