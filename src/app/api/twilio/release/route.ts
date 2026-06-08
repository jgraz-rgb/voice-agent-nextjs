import { NextRequest, NextResponse } from 'next/server';

const FASTIFY_BASE = process.env.TWILIO_SERVER_URL ?? 'http://localhost:5050';

export async function POST(_req: NextRequest) {
  try {
    const res = await fetch(`${FASTIFY_BASE}/twilio/release`, { method: 'POST' });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ success: false, error: 'Twilio server unavailable' }, { status: 503 });
  }
}
