import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const STATE_PATH = path.join(DATA_DIR, "session_state.json");

export async function POST(request: Request) {
  try {
    const payload = await request.json();
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(STATE_PATH, JSON.stringify(payload, null, 2), "utf-8");
    console.log("[/api/state POST] State saved:", JSON.stringify(payload, null, 2));
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[/api/state POST] Error writing state:", error);
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function GET() {
  try {
    const data = await fs.readFile(STATE_PATH, "utf-8");
    const state = JSON.parse(data);
    console.log("[/api/state GET] Returning state:", JSON.stringify(state, null, 2));
    return NextResponse.json(state);
  } catch {
    console.log("[/api/state GET] No state file yet, returning {}");
    return NextResponse.json({});
  }
}
