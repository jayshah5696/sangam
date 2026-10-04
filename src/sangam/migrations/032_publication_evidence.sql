-- Optional reader-facing evidence drawer for published articles.
-- Preserves the exact evidence snapshot reviewed and approved for publication.
ALTER TABLE publications ADD COLUMN evidence_json TEXT;
