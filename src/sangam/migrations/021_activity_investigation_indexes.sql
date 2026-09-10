CREATE INDEX operation_events_token_created_idx
    ON operation_events(token_id, created_at DESC, event_id DESC);

CREATE INDEX operation_events_resource_created_idx
    ON operation_events(resource_type, resource_id, created_at DESC, event_id DESC);

CREATE INDEX operation_events_action_created_idx
    ON operation_events(action, created_at DESC, event_id DESC);

CREATE INDEX operation_events_error_created_idx
    ON operation_events(error_code, created_at DESC, event_id DESC)
    WHERE error_code IS NOT NULL;
