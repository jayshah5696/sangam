CREATE TABLE projects (
    project_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    brief_document_id TEXT REFERENCES documents(document_id) ON DELETE SET NULL,
    workbench_state_json TEXT,
    active_thread_id TEXT REFERENCES chat_threads(thread_id) ON DELETE SET NULL,
    created_by TEXT NOT NULL REFERENCES actors(actor_id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX projects_created_at_idx
    ON projects(created_at DESC);

CREATE INDEX projects_updated_at_idx
    ON projects(updated_at DESC);

CREATE TABLE project_documents (
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'source' CHECK (role IN ('source', 'draft', 'output', 'note')),
    pinned_page INTEGER CHECK (pinned_page IS NULL OR pinned_page >= 1),
    notes TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, document_id)
);

CREATE INDEX project_documents_doc_idx
    ON project_documents(document_id);

CREATE TABLE project_threads (
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES chat_threads(thread_id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, thread_id)
);

CREATE INDEX project_threads_thread_idx
    ON project_threads(thread_id);

CREATE TABLE project_annotations (
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    annotation_id TEXT NOT NULL REFERENCES annotations(annotation_id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, annotation_id)
);

CREATE INDEX project_annotations_ann_idx
    ON project_annotations(annotation_id);
