-- Add auto_approve_effects column ("YOLO mode") to chat_model_settings.
-- When enabled, write effects skip the pending_approval state and execute immediately.
ALTER TABLE chat_model_settings ADD COLUMN auto_approve_effects INTEGER NOT NULL DEFAULT 0;
