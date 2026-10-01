CREATE TABLE assignments (
    assignment_id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(project_id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    token_id TEXT,
    thread_id TEXT NOT NULL REFERENCES chat_threads(thread_id),
    request_key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','running','paused','stopped','completed','failed','exhausted')),
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(actor_id, request_key)
);
CREATE INDEX assignments_queue ON assignments(status, created_at);
CREATE INDEX assignments_refresh ON assignments(json_extract(data_json, '$.refresh_proposal_id'));
CREATE TABLE assignment_inputs (
    input_id INTEGER PRIMARY KEY AUTOINCREMENT,
    assignment_id TEXT NOT NULL REFERENCES assignments(assignment_id) ON DELETE CASCADE,
    request_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(assignment_id, request_key)
);
CREATE TABLE project_visits (
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    visited_at TEXT NOT NULL,
    revisions_json TEXT NOT NULL,
    PRIMARY KEY(project_id, actor_id)
);
CREATE TABLE project_visit_results (
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    request_key TEXT NOT NULL,
    result_json TEXT NOT NULL,
    PRIMARY KEY(project_id, actor_id, request_key)
);
