# Seerstack

Personal web and product analytics: one Cloudflare Worker (Hono) that ingests events into Tinybird and serves an MCP server for agents. No UI.

## Project context

Before changing anything, read:
- `.context/concepts.md`: domain vocabulary and invariants
- `.context/architecture.md`: how the system works now
- `.context/decisions/index.md`: architectural decisions and why they were made
- `.context/plans/index.md`: work in progress
- `.context/guidance.md`: project conventions

Open the relevant ADRs and active plans before changing the areas they cover. After meaningful work, update whichever of these changed, in the same change as the code.

## Commands

- `pnpm dev`: run the Worker locally (needs `.dev.vars`, Tinybird Local and `tb build`)
- `pnpm test`, `pnpm typecheck`, `pnpm check`
- `tb build`: apply datafiles to Tinybird Local. `tb --cloud deploy`: apply them to Tinybird Cloud.
- `pnpm run deploy`: deploy the Worker
