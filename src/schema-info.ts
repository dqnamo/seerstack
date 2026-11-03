// What get_schema returns: enough for an agent to write correct SQL first try.

type Column = { name: string; type: string; description: string };

export const COLUMNS: Column[] = [
  {
    name: "project_id",
    type: "LowCardinality(String)",
    description: "Project ID from list_projects. Filter on it in every query.",
  },
  { name: "event_id", type: "String", description: "Unique ID" },
  { name: "timestamp", type: "DateTime64(3, 'UTC')", description: "When the event happened" },
  { name: "received_at", type: "DateTime64(3, 'UTC')", description: "When Seerstack received it" },
  {
    name: "event",
    type: "LowCardinality(String)",
    description: "Event name: $pageview, $identify, or a product event like signup",
  },
  {
    name: "distinct_id",
    type: "String",
    description: "user_id when known, otherwise anonymous_id. Use uniq(distinct_id) for unique visitors/users.",
  },
  { name: "user_id", type: "String", description: "Your app's user ID ('' when anonymous)" },
  {
    name: "anonymous_id",
    type: "String",
    description: "Browser visitor ID: a cookieless hash that rotates daily. Servers may set their own.",
  },
  {
    name: "properties",
    type: "String (JSON)",
    description: "Event properties. JSONExtractString(properties, 'plan'), JSONExtractFloat, JSONExtractBool, JSONHas",
  },
  { name: "url", type: "String", description: "Full page URL" },
  { name: "host", type: "LowCardinality(String)", description: "Page hostname without www" },
  { name: "path", type: "String", description: "URL path, e.g. /pricing" },
  { name: "referrer", type: "String", description: "Full referrer URL" },
  {
    name: "referrer_domain",
    type: "LowCardinality(String)",
    description: "External referrer host without www ('' = direct or internal)",
  },
  { name: "utm_source", type: "LowCardinality(String)", description: "utm_source (or ?ref=) from the page URL" },
  { name: "utm_medium", type: "LowCardinality(String)", description: "utm_medium" },
  { name: "utm_campaign", type: "LowCardinality(String)", description: "utm_campaign" },
  { name: "utm_term", type: "String", description: "utm_term" },
  { name: "utm_content", type: "String", description: "utm_content" },
  { name: "country", type: "LowCardinality(String)", description: "ISO 3166-1 alpha-2 code (browser events only)" },
  { name: "region", type: "String", description: "Region/state name (browser events only)" },
  { name: "city", type: "String", description: "City name (browser events only)" },
  {
    name: "browser",
    type: "LowCardinality(String)",
    description: "Chrome, Safari, Firefox, Edge, Opera, Samsung Internet, Other",
  },
  { name: "os", type: "LowCardinality(String)", description: "macOS, Windows, iOS, Android, Linux, ChromeOS, Other" },
  { name: "device", type: "LowCardinality(String)", description: "desktop, mobile, tablet" },
  { name: "lib", type: "LowCardinality(String)", description: "Sender: seerstack-web, server, or what the caller set" },
];

export const NOTES = [
  "One table: events, holding every project. Always filter on project_id and a timestamp range; it's sorted by (project_id, event, timestamp).",
  "ClickHouse SQL, SELECT/WITH only, one statement per call. All times are UTC.",
  "Unique visitors/users: uniq(distinct_id). Browser anonymous_ids rotate daily, so multi-day unique visitor counts are an upper bound.",
  "Sessions aren't stored: a visitor's pageviews more than 30 minutes apart start a new one (see the overview tool, or the sessions example).",
  "$identify events carry both anonymous_id and user_id, which links a visitor's anonymous activity to the user.",
  "Limits: 10 s, 1 GB memory, 10,000 result rows (truncated: true when hit). Aggregate in SQL.",
  "No system tables, SETTINGS, FORMAT, or external table functions.",
];

export const EXAMPLES: { question: string; sql: string }[] = [
  {
    question: "Daily visitors and pageviews, last 30 days",
    sql: "SELECT toDate(timestamp) AS day, uniq(distinct_id) AS visitors, count() AS pageviews FROM events WHERE project_id = 'my-site' AND event = '$pageview' AND timestamp >= today() - 29 GROUP BY day ORDER BY day",
  },
  {
    question: "Traffic across every project this week",
    sql: "SELECT project_id, uniq(distinct_id) AS visitors, countIf(event = '$pageview') AS pageviews, countIf(event != '$pageview') AS events FROM events WHERE timestamp >= now() - INTERVAL 7 DAY GROUP BY project_id ORDER BY visitors DESC",
  },
  {
    question: "Signups per day by source",
    sql: "SELECT toDate(timestamp) AS day, if(referrer_domain = '', '(direct)', referrer_domain) AS source, count() AS signups FROM events WHERE project_id = 'my-app' AND event = 'signup' AND timestamp >= now() - INTERVAL 14 DAY GROUP BY day, source ORDER BY day, signups DESC",
  },
  {
    question: "Revenue by plan from a property",
    sql: "SELECT JSONExtractString(properties, 'plan') AS plan, count() AS purchases, sum(JSONExtractFloat(properties, 'amount')) AS revenue FROM events WHERE project_id = 'my-app' AND event = 'purchase' AND timestamp >= now() - INTERVAL 30 DAY GROUP BY plan ORDER BY revenue DESC",
  },
  {
    question: "Weekly retention cohorts by first-seen week",
    sql: "WITH first AS (SELECT distinct_id, toMonday(min(timestamp)) AS cohort FROM events WHERE project_id = 'my-app' AND timestamp >= now() - INTERVAL 8 WEEK GROUP BY distinct_id) SELECT cohort, dateDiff('week', cohort, toMonday(e.timestamp)) AS week, uniq(e.distinct_id) AS users FROM events e INNER JOIN first f ON e.distinct_id = f.distinct_id WHERE e.project_id = 'my-app' AND e.timestamp >= now() - INTERVAL 8 WEEK GROUP BY cohort, week ORDER BY cohort, week",
  },
  {
    question: "Entry pages (first page of each visitor's day)",
    sql: "SELECT entry, count() AS visitors FROM (SELECT distinct_id, argMin(path, timestamp) AS entry FROM events WHERE project_id = 'my-site' AND event = '$pageview' AND timestamp >= now() - INTERVAL 7 DAY GROUP BY distinct_id, toDate(timestamp)) GROUP BY entry ORDER BY visitors DESC LIMIT 20",
  },
  {
    question: "Why did signups drop on a day? That day vs the same weekday over the previous 4 weeks, by source",
    sql: "SELECT if(referrer_domain = '', '(direct)', referrer_domain) AS source, countIf(toDate(timestamp) = toDate('2026-10-27')) AS that_day, round(countIf(toDate(timestamp) < toDate('2026-10-27')) / 4, 1) AS typical FROM events WHERE project_id = 'my-app' AND event = 'signup' AND toDayOfWeek(timestamp) = toDayOfWeek(toDate('2026-10-27')) AND timestamp >= toDate('2026-10-27') - 28 AND timestamp < toDate('2026-10-28') GROUP BY source ORDER BY (typical - that_day) DESC LIMIT 20",
  },
];
