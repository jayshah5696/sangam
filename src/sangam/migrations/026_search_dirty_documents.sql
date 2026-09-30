-- Record search work in the same commit as every searchable source change.
-- No foreign key: a removed document still needs its old FTS row removed.
CREATE TABLE search_dirty_documents (
    document_id TEXT PRIMARY KEY
);

INSERT INTO search_dirty_documents SELECT document_id FROM documents;

CREATE TRIGGER search_dirty_documents_insert
AFTER INSERT ON documents
BEGIN
    INSERT OR IGNORE INTO search_dirty_documents VALUES (NEW.document_id);
END;

CREATE TRIGGER search_dirty_documents_update
AFTER UPDATE OF title, path, current_revision_id, deleted, category ON documents
BEGIN
    INSERT OR IGNORE INTO search_dirty_documents VALUES (OLD.document_id);
    INSERT OR IGNORE INTO search_dirty_documents VALUES (NEW.document_id);
END;

CREATE TRIGGER search_dirty_documents_delete
AFTER DELETE ON documents
BEGIN
    INSERT OR IGNORE INTO search_dirty_documents VALUES (OLD.document_id);
END;

CREATE TRIGGER search_dirty_revisions_insert
AFTER INSERT ON revisions
BEGIN
    INSERT OR IGNORE INTO search_dirty_documents VALUES (NEW.document_id);
END;

CREATE TRIGGER search_dirty_revisions_update
AFTER UPDATE ON revisions
BEGIN
    INSERT OR IGNORE INTO search_dirty_documents VALUES (OLD.document_id);
    INSERT OR IGNORE INTO search_dirty_documents VALUES (NEW.document_id);
END;

CREATE TRIGGER search_dirty_revisions_delete
AFTER DELETE ON revisions
BEGIN
    INSERT OR IGNORE INTO search_dirty_documents VALUES (OLD.document_id);
END;

CREATE TRIGGER search_dirty_document_tags_insert
AFTER INSERT ON document_tags
BEGIN
    INSERT OR IGNORE INTO search_dirty_documents VALUES (NEW.document_id);
END;

CREATE TRIGGER search_dirty_document_tags_update
AFTER UPDATE ON document_tags
BEGIN
    INSERT OR IGNORE INTO search_dirty_documents VALUES (OLD.document_id);
    INSERT OR IGNORE INTO search_dirty_documents VALUES (NEW.document_id);
END;

CREATE TRIGGER search_dirty_document_tags_delete
AFTER DELETE ON document_tags
BEGIN
    INSERT OR IGNORE INTO search_dirty_documents VALUES (OLD.document_id);
END;

CREATE TRIGGER search_dirty_pdf_pages_insert
AFTER INSERT ON pdf_pages
BEGIN
    INSERT OR IGNORE INTO search_dirty_documents VALUES (NEW.document_id);
END;

CREATE TRIGGER search_dirty_pdf_pages_update
AFTER UPDATE ON pdf_pages
BEGIN
    INSERT OR IGNORE INTO search_dirty_documents VALUES (OLD.document_id);
    INSERT OR IGNORE INTO search_dirty_documents VALUES (NEW.document_id);
END;

CREATE TRIGGER search_dirty_pdf_pages_delete
AFTER DELETE ON pdf_pages
BEGIN
    INSERT OR IGNORE INTO search_dirty_documents VALUES (OLD.document_id);
END;

CREATE TRIGGER search_dirty_annotations_insert
AFTER INSERT ON annotations
BEGIN
    INSERT OR IGNORE INTO search_dirty_documents VALUES (NEW.document_id);
END;

CREATE TRIGGER search_dirty_annotations_update
AFTER UPDATE ON annotations
BEGIN
    INSERT OR IGNORE INTO search_dirty_documents VALUES (OLD.document_id);
    INSERT OR IGNORE INTO search_dirty_documents VALUES (NEW.document_id);
END;

CREATE TRIGGER search_dirty_annotations_delete
AFTER DELETE ON annotations
BEGIN
    INSERT OR IGNORE INTO search_dirty_documents VALUES (OLD.document_id);
END;

CREATE TRIGGER search_dirty_tag_name
AFTER UPDATE OF name ON tags
WHEN OLD.name IS NOT NEW.name
BEGIN
    INSERT OR IGNORE INTO search_dirty_documents
    SELECT document_id FROM document_tags WHERE tag_id = NEW.tag_id;
END;

CREATE TRIGGER search_dirty_actor_name
AFTER UPDATE OF display_name ON actors
WHEN OLD.display_name IS NOT NEW.display_name
BEGIN
    INSERT OR IGNORE INTO search_dirty_documents
    SELECT document_id FROM revisions WHERE actor_id = NEW.actor_id;
END;
