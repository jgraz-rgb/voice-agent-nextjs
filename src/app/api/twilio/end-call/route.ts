import { NextRequest, NextResponse } from 'next/server';

const FASTIFY_BASE = process.env.TWILIO_SERVER_URL ?? 'http://localhost:5050';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const res = await fetch(`${FASTIFY_BASE}/twilio/end-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ success: false, error: 'Twilio server unavailable' }, { status: 503 });
  }
}
