import { NextRequest, NextResponse } from 'next/server';

const FASTIFY_BASE = process.env.TWILIO_SERVER_URL ?? 'http://localhost:5050';

export async function GET(_req: NextRequest) {
  try {
    const res = await fetch(`${FASTIFY_BASE}/twilio/status`);
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { status: 'free', agentKey: null, expiresAt: null, callSid: null, phoneNumber: null },
      { status: 200 }
    );
  }
}
