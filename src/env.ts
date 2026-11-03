export type Env = {
  TINYBIRD_HOST: string;
  /** Static token with APPEND on `events` (`seerstack_ingest`). */
  TINYBIRD_INGEST_TOKEN: string;
  /** Static token with READ on `events` (`seerstack_read`). */
  TINYBIRD_READ_TOKEN: string;
  /** Lets your servers send events for any project, skipping the Origin check. */
  INGEST_KEY: string;
  /** Bearer token for /mcp. */
  MCP_TOKEN: string;
  /** Salt for cookieless visitor IDs. */
  ANON_SALT: string;
};
