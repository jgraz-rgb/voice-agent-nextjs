import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const TICKET_PATH = path.join(DATA_DIR, "zendesk_ticket.json");

export async function POST(request: Request) {
  try {
    const payload = await request.json();
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(TICKET_PATH, JSON.stringify(payload, null, 2), "utf-8");
    return NextResponse.json({ success: true, path: TICKET_PATH });
  } catch (error) {
    console.error("Error writing zendesk ticket:", error);
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function GET() {
  try {
    const data = await fs.readFile(TICKET_PATH, "utf-8");
    return new NextResponse(data, {
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return NextResponse.json({ error: "No ticket found yet." }, { status: 404 });
  }
}
