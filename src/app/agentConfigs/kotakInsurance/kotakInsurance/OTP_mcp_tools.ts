import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { createMCPTool } from "./mcpToolWrapper";

// 1️⃣ Create MCP client
const client = new MultiServerMCPClient({
  mobileAuth: {
    transport: "http", // or "sse" / "stdio" depending on server
    url: "http://localhost:8050/mcp",
  },
});

// 2️⃣ Wrap your send_otp tool
export const sendOtp = createMCPTool<
  { mobileNumber: string },
  { msg: string; mobile_number: string }
>(client, "mobileAuth", "send_otp");

export const verifyOtp = createMCPTool<
  { mobileNumber: string; user_input: string },
  { msg: string; otp_verified: boolean; mobile_number?: string }
>(client, "mobileAuth", "verify_otp");
