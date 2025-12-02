import { NextRequest, NextResponse } from 'next/server';

const API_BASE_URL = "http://localhost:8000";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, ...data } = body;

    let endpoint = '';
    let payload = {};

    if (action === 'send') {
      endpoint = '/sendGeneralOTP';
      payload = { phone_number: data.mobileNumber || data.phone_number };
    } else if (action === 'verify') {
      endpoint = '/verifyGeneralOTP';
      payload = { 
        otp_reference_id: data.otp_reference_id,
        otp_code: data.otp_code 
      };
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('OTP API Error:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
