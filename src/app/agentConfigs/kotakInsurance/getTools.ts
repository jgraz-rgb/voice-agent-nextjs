'use server';
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
const mcpServers = {
    mobile_otp_verification: {
        transport: "http" as const,
        type: "http" as const, // ✅ required for correct typing
    },
    email_tools: {
        transport: "http" as const,
        type: "http" as const,
        url: "http://email_MCP:16500/mcp/",
    },
    zendesk: {
        transport: "sse" as const,
        type: "sse" as const,
        url: "http://zendesk-mcp:5015/zendesk-server/mcp",
    },
} as const;
// 🧩 Initialize MultiServerMCPClient
export async function initializeMCPClients() {
    try {
        const client = new MultiServerMCPClient(mcpServers as any)
        const mcp_tools = await client.getTools();
        console.log("🚀 Loan workflow loaded at startup.");
        return mcp_tools;
    } catch (err) {
        console.error("❌ Error initializing MCP clients:", err);
        throw err;
    }
}