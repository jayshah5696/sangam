-- sangam:foreign-keys-off
ALTER TABLE mutation_idempotency_keys RENAME TO mutation_keys_before_proposals;
CREATE TABLE mutation_idempotency_keys (
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    idempotency_key TEXT NOT NULL,
    operation TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    resource_type TEXT NOT NULL CHECK (resource_type IN (
        'tag', 'folder', 'backup', 'document', 'publication', 'publication_revision',
        'pdf_document', 'annotation', 'project', 'comment', 'chat_profile', 'chat_skill', 'proposal'
    )),
    resource_id TEXT NOT NULL,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (actor_id, idempotency_key)
);
INSERT INTO mutation_idempotency_keys SELECT * FROM mutation_keys_before_proposals;
DROP TABLE mutation_keys_before_proposals;

CREATE TABLE chat_proposals_owned (
    proposal_id TEXT PRIMARY KEY,
    owner_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    thread_id TEXT REFERENCES chat_threads(thread_id) ON DELETE SET NULL,
    document_id TEXT NOT NULL REFERENCES documents(document_id),
    expected_revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
    content TEXT NOT NULL,
    summary TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'stale', 'dismissed')),
    applied_revision_id TEXT REFERENCES revisions(revision_id),
    created_at TEXT NOT NULL,
    applied_at TEXT,
    apply_idempotency_key TEXT,
    context_id TEXT REFERENCES chat_turn_contexts(context_id) ON DELETE SET NULL,
    run_id TEXT REFERENCES chat_runs(run_id) ON DELETE SET NULL,
    rationale TEXT,
    judgment_needed TEXT,
    citations_json TEXT NOT NULL DEFAULT '[]',
    sources_retrieved_json TEXT NOT NULL DEFAULT '[]',
    apply_payload_digest TEXT,
    apply_actor_id TEXT REFERENCES actors(actor_id),
    reviewed_content TEXT,
    applied_content TEXT,
    model_opinion TEXT,
    execution_key TEXT,
    version INTEGER NOT NULL DEFAULT 1
);
INSERT INTO chat_proposals_owned (
    proposal_id, owner_actor_id, thread_id, document_id, expected_revision_id,
    content, summary, status, applied_revision_id, created_at, applied_at,
    apply_idempotency_key, context_id, run_id, rationale, judgment_needed,
    citations_json, sources_retrieved_json, apply_payload_digest, apply_actor_id,
    reviewed_content, applied_content, model_opinion
)
SELECT p.proposal_id, t.created_by, p.thread_id, p.document_id, p.expected_revision_id,
    p.content, p.summary, p.status, p.applied_revision_id, p.created_at, p.applied_at,
    p.apply_idempotency_key, p.context_id, p.run_id, p.rationale, p.judgment_needed,
    p.citations_json, p.sources_retrieved_json, p.apply_payload_digest, p.apply_actor_id,
    p.reviewed_content, p.applied_content, p.model_opinion
FROM chat_proposals p JOIN chat_threads t ON t.thread_id=p.thread_id;
DROP TABLE chat_proposals;
ALTER TABLE chat_proposals_owned RENAME TO chat_proposals;
CREATE INDEX chat_proposals_thread_created_idx ON chat_proposals(thread_id, created_at DESC);
CREATE INDEX chat_proposals_apply_key_idx ON chat_proposals(apply_idempotency_key) WHERE apply_idempotency_key IS NOT NULL;
CREATE INDEX chat_proposals_context_idx ON chat_proposals(context_id);
CREATE INDEX chat_proposals_run_idx ON chat_proposals(run_id);
CREATE INDEX chat_proposals_owner_document_idx ON chat_proposals(owner_actor_id, document_id, created_at DESC);
CREATE TRIGGER chat_proposals_version AFTER UPDATE ON chat_proposals
WHEN NEW.version = OLD.version BEGIN
    UPDATE chat_proposals SET version = version + 1 WHERE proposal_id = NEW.proposal_id;
END;
