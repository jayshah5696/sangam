CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    primary_document_id TEXT REFERENCES documents(document_id) ON DELETE SET NULL,
    resume_hint TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    metadata_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS projects_updated_at_idx
    ON projects(updated_at DESC);

CREATE TABLE IF NOT EXISTS project_documents (
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'draft',
    context_summary TEXT,
    resume_hint TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, document_id)
);

CREATE INDEX IF NOT EXISTS project_documents_document_idx
    ON project_documents(document_id);

CREATE INDEX IF NOT EXISTS project_documents_role_idx
    ON project_documents(project_id, role);
