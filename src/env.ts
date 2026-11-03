import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { ImportParams } from "./imports";

export type Env = {
  /** Projects and their keys, and imports. */
  DB: D1Database;
  /** The PostHog import Workflow (src/import-workflow.ts). */
  IMPORTS: Workflow<ImportParams>;
  /** OAuth clients, grants and tokens (workers-oauth-provider). */
  OAUTH_KV: KVNamespace;
  /** Injected by OAuthProvider into the default handler. */
  OAUTH_PROVIDER: OAuthHelpers;
  TINYBIRD_HOST: string;
  /** Static token with APPEND on `events` (`seerstack_ingest`). */
  TINYBIRD_INGEST_TOKEN: string;
  /** Static token with READ on `events` (`seerstack_read`). */
  TINYBIRD_READ_TOKEN: string;
  /** Salt for cookieless visitor IDs. */
  ANON_SALT: string;
  /** The GitHub OAuth App that signs you in on /authorize. */
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  /** The only GitHub account (numeric user ID) allowed to authorize MCP clients. */
  ALLOWED_GITHUB_USER_ID: string;
};
