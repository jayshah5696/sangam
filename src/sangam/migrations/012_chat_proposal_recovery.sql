ALTER TABLE chat_proposals ADD COLUMN apply_idempotency_key TEXT;

CREATE INDEX chat_proposals_apply_key_idx
    ON chat_proposals(apply_idempotency_key)
    WHERE apply_idempotency_key IS NOT NULL;
