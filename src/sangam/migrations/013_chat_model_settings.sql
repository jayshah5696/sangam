CREATE TABLE chat_model_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    openrouter_enabled INTEGER NOT NULL DEFAULT 1,
    default_model TEXT NOT NULL,
    enabled_models_json TEXT NOT NULL,
    catalog_json TEXT NOT NULL,
    catalog_fetched_at TEXT,
    updated_at TEXT NOT NULL
);
