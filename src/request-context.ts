import { AsyncLocalStorage } from "node:async_hooks";

/** Carries the MCP request's abort signal down to Jira HTTP calls so client cancellation stops in-flight work. */
export const requestSignal = new AsyncLocalStorage<AbortSignal | undefined>();
