-- Pin each publication to the exact revision its readers see. Saving the draft
-- no longer changes the public view; updating a publication is a deliberate act.
-- Existing publications keep showing what they showed before this migration.
ALTER TABLE publications ADD COLUMN revision_id TEXT REFERENCES revisions(revision_id);

UPDATE publications
SET revision_id = (
    SELECT d.current_revision_id FROM documents d WHERE d.document_id = publications.document_id
);
