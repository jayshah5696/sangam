ALTER TABLE chat_proposals
    ADD COLUMN context_id TEXT REFERENCES chat_turn_contexts(context_id);

CREATE INDEX chat_proposals_context_idx
    ON chat_proposals(context_id);
