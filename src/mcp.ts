import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { breakdown, DIMENSIONS, funnel, listEvents, overview, projectActivity, timeseries } from "./analytics";
import type { Env } from "./env";
import { QueryError } from "./errors";
import { defaultInterval, INTERVALS, PERIODS, resolveRange } from "./periods";
import type { Project } from "./projects";
import { COLUMNS, EXAMPLES, NOTES } from "./schema-info";
import { runSql } from "./tinybird";

const INSTRUCTIONS = `Seerstack holds web and product analytics for all of this user's projects. There is no dashboard: answer questions by calling these tools.

- Start with list_projects to see project IDs and recent activity.
- Use overview, timeseries, breakdown, list_events and funnel for common questions. They take a period (default 7d) or date_from/date_to, and exact-match filters.
- For anything else, call get_schema, then run_sql with ClickHouse SQL against the single events table (always filter on project_id and timestamp).
- Answer "why" questions by comparing periods and breaking down by referrer_domain, utm_*, path, country, browser, os and device.
All times are UTC.`;

function ok(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function fail(error: unknown): CallToolResult {
  if (error instanceof QueryError) {
    return {
      isError: true,
      content: [{ type: "text", text: `${error.message}${error.hint ? `\nHint: ${error.hint}` : ""}` }],
    };
  }
  console.error(error);
  return { isError: true, content: [{ type: "text", text: "Something went wrong. Retry in a moment." }] };
}

const run = (fn: () => Promise<unknown>) => fn().then(ok, fail);

const readOnly = { readOnlyHint: true, openWorldHint: false };

const projectArg = z
  .string()
  .optional()
  .describe("Project ID from list_projects. Optional when there is only one project.");
const rangeArgs = {
  period: z
    .enum(PERIODS)
    .optional()
    .describe(
      "Time range, UTC. Default 7d. 7d/30d/90d include today; 12mo starts on the 1st of the month 11 months ago.",
    ),
  date_from: z.string().optional().describe("Custom range start, YYYY-MM-DD. Use with date_to instead of period."),
  date_to: z.string().optional().describe("Custom range end, YYYY-MM-DD, inclusive."),
};
const filtersArg = z
  .record(z.string(), z.string())
  .optional()
  .describe(
    `Exact-match filters on ${DIMENSIONS.join(", ")} or properties.<key>, e.g. {"path": "/pricing", "properties.plan": "pro"}. "(none)" matches empty values.`,
  );

export function buildMcpServer(env: Env, projects: Record<string, Project>): McpServer {
  const server = new McpServer(
    { name: "seerstack", title: "Seerstack", version: "1.0.0" },
    { instructions: INSTRUCTIONS },
  );

  const projectId = (id: string | undefined): string => {
    const ids = Object.keys(projects);
    if (id === undefined && ids.length === 1) return ids[0] as string;
    if (id !== undefined && Object.hasOwn(projects, id)) return id;
    throw new QueryError(
      id === undefined ? "Pass a project" : `Unknown project "${id}"`,
      `Projects: ${ids.join(", ")}.`,
    );
  };

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description:
        "Every tracked project with its domains and the last 30 days of activity (events, visitors, last event time).",
      inputSchema: {},
      annotations: readOnly,
    },
    () =>
      run(async () => {
        const activity = await projectActivity(env);
        return {
          projects: Object.entries(projects).map(([id, p]) => ({
            id,
            ...p,
            ...(activity.get(id) ?? { events_30d: 0, visitors_30d: 0, last_event: null }),
          })),
        };
      }),
  );

  server.registerTool(
    "overview",
    {
      title: "Overview",
      description:
        "Headline web metrics for a period: visitors, pageviews, sessions, bounce rate, average session length, views per session, and the count of non-pageview events. Compares against the previous period of the same length by default.",
      inputSchema: {
        project: projectArg,
        ...rangeArgs,
        filters: filtersArg,
        compare: z.boolean().optional().describe("Include the previous period and % change. Default true."),
      },
      annotations: readOnly,
    },
    (args) => run(() => overview(env, projectId(args.project), resolveRange(args), args.filters, args.compare ?? true)),
  );

  server.registerTool(
    "timeseries",
    {
      title: "Timeseries",
      description:
        "Visitors and event counts per time bucket, with empty buckets filled with zeros. Counts pageviews unless you pass an event.",
      inputSchema: {
        project: projectArg,
        ...rangeArgs,
        interval: z
          .enum(INTERVALS)
          .optional()
          .describe("Bucket size. Default: hour up to 2 days, day up to 92 days, else month."),
        event: z.string().optional().describe("Event to count. Default $pageview."),
        filters: filtersArg,
      },
      annotations: readOnly,
    },
    (args) =>
      run(async () => {
        const range = resolveRange(args);
        return timeseries(
          env,
          projectId(args.project),
          range,
          args.interval ?? defaultInterval(range),
          args.event ?? "$pageview",
          args.filters,
        );
      }),
  );

  server.registerTool(
    "breakdown",
    {
      title: "Breakdown",
      description:
        'Top values of one dimension by visitors: top pages (path), sources (referrer_domain, utm_*), locations (country, region, city), tech (browser, os, device), events (event), or any property (properties.<key>). Counts pageviews by default; pass event to break down another event, e.g. {"dimension": "properties.plan", "event": "signup"}. With dimension "event", all events are counted.',
      inputSchema: {
        project: projectArg,
        ...rangeArgs,
        dimension: z.string().describe(`One of ${DIMENSIONS.join(", ")}, or properties.<key>.`),
        event: z
          .string()
          .optional()
          .describe("Event to count. Default $pageview (all events when dimension is event)."),
        filters: filtersArg,
        limit: z.number().int().min(1).max(1000).optional().describe("Rows to return. Default 10."),
      },
      annotations: readOnly,
    },
    (args) =>
      run(() =>
        breakdown(
          env,
          projectId(args.project),
          resolveRange(args),
          args.dimension,
          args.event ?? (args.dimension === "event" ? undefined : "$pageview"),
          args.filters,
          args.limit ?? 10,
        ),
      ),
  );

  server.registerTool(
    "list_events",
    {
      title: "List events",
      description:
        "Every event name a project sent in the period (default 30d), with counts, unique users, last seen time and the property keys it carries.",
      inputSchema: { project: projectArg, ...rangeArgs },
      annotations: readOnly,
    },
    (args) =>
      run(() => listEvents(env, projectId(args.project), resolveRange({ ...args, period: args.period ?? "30d" }))),
  );

  server.registerTool(
    "funnel",
    {
      title: "Funnel",
      description:
        "How many people completed each step in order within a time window, with conversion rates. A step is an event, optionally narrowed to a path (useful for $pageview). Anonymous visitors who later identify count as that user. Default period 30d.",
      inputSchema: {
        project: projectArg,
        ...rangeArgs,
        steps: z
          .array(z.object({ event: z.string().min(1), path: z.string().optional() }))
          .min(2)
          .max(10)
          .describe('Ordered steps, e.g. [{"event": "$pageview", "path": "/pricing"}, {"event": "signup"}]'),
        window_hours: z
          .number()
          .int()
          .min(1)
          .max(2160)
          .optional()
          .describe("Max time from step 1 to the last step. Default 24."),
      },
      annotations: readOnly,
    },
    (args) =>
      run(() =>
        funnel(
          env,
          projectId(args.project),
          resolveRange({ ...args, period: args.period ?? "30d" }),
          args.steps,
          (args.window_hours ?? 24) * 3600,
        ),
      ),
  );

  server.registerTool(
    "get_schema",
    {
      title: "Get schema",
      description: "The events table's columns, SQL notes and example queries. Call this before run_sql.",
      inputSchema: {},
      annotations: readOnly,
    },
    () =>
      run(async () => ({
        table: "events",
        columns: COLUMNS,
        notes: NOTES,
        examples: EXAMPLES,
        projects: Object.keys(projects),
      })),
  );

  server.registerTool(
    "run_sql",
    {
      title: "Run SQL",
      description:
        "Run one read-only ClickHouse SELECT against the events table (all projects; filter on project_id). Limits: 10 s, 10,000 rows. Returns columns, rows, truncated and stats.",
      inputSchema: { sql: z.string().describe("A single ClickHouse SELECT or WITH query") },
      annotations: readOnly,
    },
    ({ sql }) => run(() => runSql(env, sql)),
  );

  return server;
}

// Stateless Streamable HTTP: a fresh server and transport per request, JSON
// responses, no sessions to keep.
export async function handleMcp(env: Env, projects: Record<string, Project>, request: Request): Promise<Response> {
  const server = buildMcpServer(env, projects);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
