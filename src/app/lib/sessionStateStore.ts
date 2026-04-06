/**
 * In-process session state store using Node.js global.
 * Next.js can create separate module instances per bundle chunk, so a plain
 * module-level variable won't be shared between the agent tool code and the
 * API route. Attaching to `global` guarantees a single shared reference
 * across the entire server process regardless of bundling.
 */

declare global {
  // eslint-disable-next-line no-var
  var __bfsiSessionState: Record<string, unknown> | undefined;
}

export function setSessionState(state: Record<string, unknown>): void {
  global.__bfsiSessionState = state;
}

export function getSessionState(): Record<string, unknown> {
  return global.__bfsiSessionState ?? {};
}
