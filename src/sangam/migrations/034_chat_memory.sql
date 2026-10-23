CREATE TABLE chat_profile_facts (
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    scope TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    content TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'suggested', 'forgotten')),
    version INTEGER NOT NULL,
    source_thread_id TEXT,
    source_item_id TEXT,
    source_key TEXT,
    PRIMARY KEY (actor_id, scope, memory_id)
);
CREATE VIRTUAL TABLE chat_profile_facts_fts USING fts5(content, content='chat_profile_facts', content_rowid='rowid');
CREATE TRIGGER chat_profile_facts_insert AFTER INSERT ON chat_profile_facts BEGIN
    INSERT INTO chat_profile_facts_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER chat_profile_facts_update AFTER UPDATE ON chat_profile_facts BEGIN
    INSERT INTO chat_profile_facts_fts(chat_profile_facts_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO chat_profile_facts_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TABLE chat_profile_memory_reads (
    context_id TEXT NOT NULL REFERENCES chat_turn_contexts(context_id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    PRIMARY KEY (context_id, actor_id, scope, memory_id)
);
