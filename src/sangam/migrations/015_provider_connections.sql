-- sangam:foreign-keys-off
CREATE TABLE provider_connections (
    connection_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    preset TEXT,
    protocol TEXT NOT NULL CHECK (protocol IN ('openai_responses', 'openai_chat_completions')),
    base_url TEXT NOT NULL,
    credential_env TEXT,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    health_status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (health_status IN ('unknown', 'ready', 'unreachable', 'incompatible')),
    last_checked_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX provider_connections_enabled_name_idx
    ON provider_connections(enabled, name COLLATE NOCASE, connection_id);

INSERT INTO provider_connections(
    connection_id, name, preset, protocol, base_url, credential_env,
    enabled, version, health_status, created_at, updated_at
) VALUES (
    'openrouter', 'OpenRouter', 'openrouter', 'openai_responses',
    'https://openrouter.ai/api/v1', 'SANGAM_OPENROUTER_API_KEY',
    1, 1, 'unknown', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);

ALTER TABLE chat_model_settings ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE token_scopes_new (
    token_id TEXT NOT NULL REFERENCES actor_tokens(token_id) ON DELETE CASCADE,
    capability TEXT NOT NULL CHECK (
        capability IN (
            'read', 'search', 'create', 'update', 'move', 'tag', 'restore',
            'delete', 'publish', 'inference'
        )
    ),
    path_prefix TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (token_id, capability, path_prefix)
);

INSERT INTO token_scopes_new(token_id, capability, path_prefix)
SELECT token_id, capability, path_prefix FROM token_scopes;

DROP TABLE token_scopes;
ALTER TABLE token_scopes_new RENAME TO token_scopes;
