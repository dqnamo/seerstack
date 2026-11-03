// Stand-in for the `cloudflare:workers` runtime module, which only exists in
// workerd. workers-oauth-provider imports WorkerEntrypoint from it.
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    readonly ctx: ExecutionContext,
    readonly env: Env,
  ) {}
}
