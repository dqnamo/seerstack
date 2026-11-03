-- Imports of past events from another analytics tool (PostHog). Each row is
-- one run of the import Workflow; its ID is the Workflow instance ID.
CREATE TABLE imports (
  id TEXT PRIMARY KEY,                    -- imp_…
  project_id TEXT NOT NULL,
  source TEXT NOT NULL,                   -- posthog
  source_project TEXT NOT NULL,           -- e.g. https://us.posthog.com/project/479710
  status TEXT NOT NULL,                   -- running, completed, failed, cancelled
  range_from TEXT NOT NULL,               -- ISO; events in [range_from, range_until) are imported
  range_until TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '{}',     -- JSON: events, visitor_ids
  estimated INTEGER NOT NULL,             -- events PostHog counted in the range when the import started
  imported INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,     -- bots and same-path navigations, which the live tracker drops too
  position TEXT,                          -- ISO; everything before it has been read
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX imports_by_project ON imports (project_id, created_at);

-- One running import per project: two at once could both write the same page.
CREATE UNIQUE INDEX one_running_import_per_project ON imports (project_id) WHERE status = 'running';
