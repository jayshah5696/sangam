CREATE TABLE activity_problem_acknowledgements (
    event_id TEXT PRIMARY KEY REFERENCES operation_events(event_id) ON DELETE CASCADE,
    acknowledged_at TEXT NOT NULL,
    acknowledged_by TEXT NOT NULL REFERENCES actors(actor_id)
);

CREATE INDEX activity_problem_acknowledgements_actor_created_idx
    ON activity_problem_acknowledgements(acknowledged_by, acknowledged_at DESC);
