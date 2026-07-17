CREATE INDEX operation_events_revision_outcome_created_idx
    ON operation_events(revision_id, outcome, created_at, operation_id);

CREATE INDEX documents_deleted_updated_idx
    ON documents(deleted, updated_at DESC, document_id);

CREATE INDEX documents_category_idx
    ON documents(category COLLATE NOCASE);
