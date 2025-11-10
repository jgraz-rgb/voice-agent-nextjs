import { MultiServerMCPClient } from "@langchain/mcp-adapters";

/**
 * Wraps an MCP tool call using MultiServerMCPClient.
 * @param client Instance of MultiServerMCPClient
 * @param serverName Name of the MCP server configured in the client
 * @param toolName Name of the MCP tool on that server
 * @returns A callable function that executes the MCP tool with parameters
 */
export function createMCPTool<TParams extends Record<string, any>, TResult>(
  client: MultiServerMCPClient,
  serverName: string,
  toolName: string
) {
  return async (params: TParams): Promise<TResult> => {
    try {
      // Get the tool reference from the client
      const tools = await client.getTools();
      const serverTools = tools[serverName];
      if (!serverTools || !serverTools[toolName]) {
        throw new Error(`Tool "${toolName}" not found on server "${serverName}"`);
      }

      // Call the tool
      const result = await serverTools[toolName].call(params);
      return result as TResult;
    } catch (err: any) {
      console.error(`Error calling MCP tool "${toolName}" on server "${serverName}":`, err);
      throw err;
    }
  };
}

