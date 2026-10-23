ALTER TABLE chat_threads ADD COLUMN project_id TEXT REFERENCES projects(project_id) ON DELETE SET NULL;
ALTER TABLE chat_threads ADD COLUMN history_generation INTEGER NOT NULL DEFAULT 0;

CREATE TABLE chat_task_revisions (
    thread_id TEXT NOT NULL REFERENCES chat_threads(thread_id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    state_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(thread_id, version)
);
CREATE TABLE chat_task_mutations (
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_json TEXT NOT NULL,
    PRIMARY KEY(actor_id, idempotency_key)
);

-- Index only message text. Attachments, widgets and tool arguments are not history excerpts.
CREATE VIRTUAL TABLE chat_history_fts USING fts5(item_id UNINDEXED, thread_id UNINDEXED, text);
INSERT INTO chat_history_fts(rowid, item_id, thread_id, text)
SELECT i.rowid, i.item_id, i.thread_id, group_concat(json_extract(c.value, '$.text'), char(10))
FROM chat_thread_items i,
json_each(COALESCE(json_extract(i.data_json, '$.payload.content'), json_extract(i.data_json, '$.content'))) c
WHERE COALESCE(json_extract(i.data_json, '$.payload.type'), json_extract(i.data_json, '$.type'))
      IN ('user_message', 'assistant_message')
GROUP BY i.item_id;

CREATE TRIGGER chat_history_insert AFTER INSERT ON chat_thread_items BEGIN
    INSERT INTO chat_history_fts(rowid, item_id, thread_id, text)
    SELECT NEW.rowid, NEW.item_id, NEW.thread_id, group_concat(json_extract(c.value, '$.text'), char(10))
    FROM json_each(COALESCE(json_extract(NEW.data_json, '$.payload.content'), json_extract(NEW.data_json, '$.content'))) c
    WHERE COALESCE(json_extract(NEW.data_json, '$.payload.type'), json_extract(NEW.data_json, '$.type'))
          IN ('user_message', 'assistant_message')
    HAVING count(*) > 0;
END;
CREATE TRIGGER chat_history_update AFTER UPDATE OF data_json ON chat_thread_items
WHEN OLD.data_json <> NEW.data_json BEGIN
    UPDATE chat_threads SET history_generation=history_generation+1 WHERE thread_id=NEW.thread_id;
    DELETE FROM chat_history_fts WHERE rowid=OLD.rowid;
    INSERT INTO chat_history_fts(rowid, item_id, thread_id, text)
    SELECT NEW.rowid, NEW.item_id, NEW.thread_id, group_concat(json_extract(c.value, '$.text'), char(10))
    FROM json_each(COALESCE(json_extract(NEW.data_json, '$.payload.content'), json_extract(NEW.data_json, '$.content'))) c
    WHERE COALESCE(json_extract(NEW.data_json, '$.payload.type'), json_extract(NEW.data_json, '$.type'))
          IN ('user_message', 'assistant_message')
    HAVING count(*) > 0;
END;
CREATE TRIGGER chat_history_delete AFTER DELETE ON chat_thread_items BEGIN
    UPDATE chat_threads SET history_generation=history_generation+1 WHERE thread_id=OLD.thread_id;
    DELETE FROM chat_history_fts WHERE rowid=OLD.rowid;
END;
