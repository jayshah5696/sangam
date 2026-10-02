-- An approved chat effect runs with the requester's authority, not the approver's.
-- An agent requester is identified by its token so grants are read fresh at execution.
ALTER TABLE chat_effects ADD COLUMN requested_token_id TEXT;
