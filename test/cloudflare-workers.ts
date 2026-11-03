// Stand-in for the `cloudflare:workers` runtime module, which only exists in
// workerd. workers-oauth-provider imports WorkerEntrypoint from it, and the
// import Workflow extends WorkflowEntrypoint.
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    readonly ctx: ExecutionContext,
    readonly env: Env,
  ) {}
}

export class WorkflowEntrypoint<Env = unknown> {
  constructor(
    protected ctx: ExecutionContext,
    protected env: Env,
  ) {}
}
