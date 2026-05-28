import { NextRequest, NextResponse } from "next/server";

const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";

async function createSession(body: {
  instructions?: string;
  output_modalities?: string[];
  voice?: string;
  transcription_language?: string;
}) {
  const model = process.env.NEXT_PUBLIC_REALTIME_MODEL || "gpt-realtime-1.5";

  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model,
        instructions: body.instructions || DEFAULT_INSTRUCTIONS,
        output_modalities: body.output_modalities ?? ["audio"],
        audio: {
          input: {
            transcription: {
              model: "gpt-4o-transcribe",
              language: body.transcription_language ?? "en",
            },
            turn_detection: {
              type: "server_vad",
            },
          },
          output: {
            voice: body.voice ?? "verse",
          },
        },
      },
      expires_after: {
        anchor: "created_at",
        seconds: 600,
      },
    }),
  });

  const data = await response.json();

  console.log("[/api/session] status:", response.status, "| model:", model);
  console.log("[/api/session] session instructions prefix:",
    typeof data.session?.instructions === 'string'
      ? data.session.instructions.slice(0, 80) + '...'
      : 'MISSING'
  );

  if (!response.ok) {
    console.error("[/api/session] OpenAI error:", data);
    throw new Error(data?.error?.message ?? "Failed to create realtime session");
  }

  const ephemeralKey = data.value ?? data.client_secret?.value;
  return { ephemeralKey, data };
}

// GET — legacy support, creates session with default config
export async function GET() {
  try {
    const { ephemeralKey, data } = await createSession({});
    return NextResponse.json({
      client_secret: { value: ephemeralKey },
      ...data,
    });
  } catch (error: any) {
    console.error("Session token error:", error);
    return NextResponse.json(
      { error: error.message ?? "Failed to create realtime session" },
      { status: 500 }
    );
  }
}

// POST — agent passes its own instructions, modalities, voice, language
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { ephemeralKey, data } = await createSession(body);
    return NextResponse.json({
      client_secret: { value: ephemeralKey },
      ...data,
    });
  } catch (error: any) {
    console.error("Session token error:", error);
    return NextResponse.json(
      { error: error.message ?? "Failed to create realtime session" },
      { status: 500 }
    );
  }
}
