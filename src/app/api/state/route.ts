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

/** PATCH — merge partial fields into existing state without overwriting the whole document */
export async function PATCH(request: Request) {
  try {
    const partial = await request.json();
    await fs.mkdir(DATA_DIR, { recursive: true });
    let existing: Record<string, unknown> = {};
    try {
      const data = await fs.readFile(STATE_PATH, "utf-8");
      existing = JSON.parse(data);
    } catch { /* no existing file is fine */ }
    const merged = { ...existing, ...partial };
    await fs.writeFile(STATE_PATH, JSON.stringify(merged, null, 2), "utf-8");
    console.log("[/api/state PATCH] State merged:", JSON.stringify(partial, null, 2));
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[/api/state PATCH] Error merging state:", error);
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
