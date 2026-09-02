ALTER TABLE chat_effects ADD COLUMN acknowledged_at TEXT;
ALTER TABLE chat_effects ADD COLUMN acknowledged_by TEXT REFERENCES actors(actor_id);

CREATE INDEX chat_effects_thread_attention_idx
    ON chat_effects(thread_id, status, acknowledged_at, created_at DESC);
