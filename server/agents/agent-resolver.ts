// Agent key → display name mapping (safe to import in Node context, no browser deps)
// The actual RealtimeAgent objects live in Next.js client code and cannot be imported here.
// We pass agentKey to the Next.js /api/session endpoint which looks up the real agent config.

export const VALID_AGENT_KEYS = [
  'simpleHandoff',
  'customerServiceRetail',
  'chatSupervisor',
  'kotakInsurance',
  'usHealthInsurance',
  'aaaInsurance',
  'licSales',
] as const;

export type AgentKey = typeof VALID_AGENT_KEYS[number];

export function isValidAgentKey(key: string): key is AgentKey {
  return (VALID_AGENT_KEYS as readonly string[]).includes(key);
}

export function validAgentKeys(): string[] {
  return [...VALID_AGENT_KEYS];
}
