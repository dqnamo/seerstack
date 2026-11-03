-- Projects and their ingest keys. Created and changed through the MCP tools.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,                    -- slug used in queries, e.g. saintdex
  name TEXT NOT NULL,
  domains TEXT NOT NULL DEFAULT '[]',     -- JSON array of hostnames allowed to send browser events
  public_key TEXT NOT NULL UNIQUE,        -- pk_…, goes in the script tag
  secret_key_hash TEXT NOT NULL UNIQUE,   -- SHA-256 of sk_…, for server-side events
  created_at TEXT NOT NULL
);
