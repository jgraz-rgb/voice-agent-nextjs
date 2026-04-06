/**
 * Hook for communicating with the InsureAssist LangGraph backend.
 * Supports both streaming (SSE) and non-streaming chat endpoints.
 */

const API_BASE = "https://bfsi.searchunify.com/bfsi-api/";

export interface APIMessage {
  role: "user" | "bot";
  content: string;
}

export interface ChatPayload {
  messages: APIMessage[];
  action?: string | null;
  flow_context?: Record<string, string> | null;
}

/**
 * Send a chat request and stream tokens back via callback.
 * Returns the full accumulated response text.
 */
export async function streamChat(
  payload: ChatPayload,
  onToken: (token: string) => void,
  onToolStart?: (tool: string) => void,
  onToolEnd?: (tool: string) => void
): Promise<string> {
  const response = await fetch(`${API_BASE}/health-chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let accumulated = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr) continue;

      try {
        const event = JSON.parse(jsonStr);

        if (event.type === "token") {
          accumulated += event.content;
          onToken(event.content);
        } else if (event.type === "tool_start" && onToolStart) {
          onToolStart(event.tool);
        } else if (event.type === "tool_end" && onToolEnd) {
          onToolEnd(event.tool);
        } else if (event.type === "error") {
          throw new Error(event.content);
        }
        // "done" type — loop will end naturally
      } catch (e) {
        if (e instanceof SyntaxError) continue; // skip malformed JSON
        throw e;
      }
    }
  }

  return accumulated;
}

/**
 * Non-streaming chat — returns the full response at once.
 */
export async function sendChat(payload: ChatPayload): Promise<string> {
  const response = await fetch(`${API_BASE}/health-chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const data = await response.json();
  return data.content;
}

/**
 * Fetch available policies from the backend.
 */
export async function fetchPolicies(): Promise<string[]> {
  const response = await fetch(`${API_BASE}/policies`);
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  const data = await response.json();
  return data.policies;
}

/**
 * Check if the backend is reachable.
 */
export async function checkBackendHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}
