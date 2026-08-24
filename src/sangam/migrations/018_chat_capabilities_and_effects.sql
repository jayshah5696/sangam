CREATE TABLE chat_turn_contexts (
    context_id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    thread_id TEXT REFERENCES chat_threads(thread_id) ON DELETE CASCADE,
    -- ChatKit invokes the responder before it commits the triggering item. Keep
    -- the stable item identifier without a foreign key so the context can be
    -- attached atomically during that responder window.
    user_item_id TEXT UNIQUE,
    entry_point TEXT NOT NULL CHECK (entry_point IN ('workspace', 'document')),
    document_id TEXT REFERENCES documents(document_id),
    revision_id TEXT REFERENCES revisions(revision_id),
    pdf_page_number INTEGER CHECK (pdf_page_number IS NULL OR pdf_page_number >= 1),
    annotation_id TEXT,
    selection_text TEXT NOT NULL DEFAULT '',
    selection_digest TEXT NOT NULL,
    model_ref TEXT,
    capability_manifest_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    attached_at TEXT
);

CREATE INDEX chat_turn_contexts_actor_created_idx
    ON chat_turn_contexts(actor_id, created_at DESC);

CREATE TABLE chat_runs (
    run_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES chat_threads(thread_id) ON DELETE CASCADE,
    user_item_id TEXT,
    context_id TEXT NOT NULL REFERENCES chat_turn_contexts(context_id),
    actor_id TEXT NOT NULL REFERENCES actors(actor_id),
    connection_id TEXT NOT NULL,
    model_ref TEXT NOT NULL,
    capability_manifest_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
    provider_correlation_id TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    error_class TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT
);

CREATE INDEX chat_runs_thread_started_idx
    ON chat_runs(thread_id, started_at DESC);

CREATE TABLE chat_run_tools (
    event_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES chat_runs(run_id) ON DELETE CASCADE,
    tool_call_id TEXT,
    capability_id TEXT NOT NULL,
    capability_version INTEGER NOT NULL,
    effect_class TEXT NOT NULL CHECK (effect_class IN ('read', 'propose', 'write', 'external')),
    approval_policy TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'failed', 'pending_approval')),
    duration_ms INTEGER NOT NULL,
    result_bytes INTEGER NOT NULL,
    citation_count INTEGER NOT NULL,
    error_class TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX chat_run_tools_run_created_idx
    ON chat_run_tools(run_id, created_at, event_id);

CREATE TABLE chat_effects (
    effect_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES chat_runs(run_id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES chat_threads(thread_id) ON DELETE CASCADE,
    tool_call_id TEXT NOT NULL,
    capability_id TEXT NOT NULL,
    capability_version INTEGER NOT NULL,
    requested_by TEXT NOT NULL REFERENCES actors(actor_id),
    arguments_json TEXT NOT NULL,
    argument_digest TEXT NOT NULL,
    preview_json TEXT NOT NULL,
    effect_class TEXT NOT NULL CHECK (effect_class IN ('write', 'external')),
    risk TEXT NOT NULL CHECK (risk IN ('workspace', 'external')),
    status TEXT NOT NULL CHECK (
        status IN (
            'proposed', 'pending_approval', 'approved', 'denied', 'executing',
            'completed', 'failed', 'expired', 'cancelled'
        )
    ),
    operation_key TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    result_json TEXT,
    failure_json TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    UNIQUE(requested_by, tool_call_id, capability_id, argument_digest)
);

CREATE INDEX chat_effects_thread_status_created_idx
    ON chat_effects(thread_id, status, created_at DESC);

CREATE TABLE chat_effect_decisions (
    decision_id TEXT PRIMARY KEY,
    effect_id TEXT NOT NULL REFERENCES chat_effects(effect_id) ON DELETE CASCADE,
    decided_by TEXT NOT NULL REFERENCES actors(actor_id),
    argument_digest TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('approve', 'deny')),
    reason TEXT,
    decided_at TEXT NOT NULL
);

CREATE INDEX chat_effect_decisions_effect_decided_idx
    ON chat_effect_decisions(effect_id, decided_at, decision_id);
