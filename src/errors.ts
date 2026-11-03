// An error an agent can act on: what went wrong, plus a hint for what to try.
export class QueryError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}
