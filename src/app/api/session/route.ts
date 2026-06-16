import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { allAgentSets } from "@/app/agentConfigs";

const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";


function resolveInstructions(body: { instructions?: string; agentKey?: string }): string {
  if (body.instructions) return body.instructions;
  if (body.agentKey) {
    const agents = allAgentSets[body.agentKey];
    if (agents?.length) {
      const instructions = agents[0]?.instructions;
      if (typeof instructions === 'string') return instructions;
    }
  }
  return DEFAULT_INSTRUCTIONS;
}

// Extract OpenAI-format tool schemas from the RealtimeAgent config for a given agent key.
// Each FunctionTool has { type, name, description, parameters, strict } which maps
// directly to the OpenAI Realtime session tools format.
function resolveTools(body: { tools?: unknown[]; agentKey?: string }): unknown[] | undefined {
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) return body.tools;
  if (body.agentKey) {
    const agents = allAgentSets[body.agentKey];
    if (agents?.length) {
      const tools = agents[0]?.tools;
      if (Array.isArray(tools) && tools.length > 0) {
        return tools
          .filter((t: any) => t.type === 'function' && t.name && t.parameters)
          .map((t: any) => ({
            type: 'function' as const,
            name: t.name,
            description: t.description ?? '',
            parameters: t.parameters,
          }));
      }
    }
  }
  return undefined;
}

// Stricter VAD for phone calls with background noise (LIC agent).
// Higher threshold ignores low-energy noise; longer silence_duration_ms
// avoids cutting off speech mid-sentence; prefix_padding_ms catches fast
// utterance starts without false-triggering on ambient sound.
// Phone lines (G.711 μ-law, 8kHz) carry significant line noise, so the
// threshold is set aggressively high to avoid the agent reacting to static,
// breathing, or background chatter as if it were speech.
const LIC_TURN_DETECTION = {
  type: 'server_vad',
  threshold: 0.85,          // default 0.5 — phone lines are noisy, only fire on clear speech
  silence_duration_ms: 900, // default 500 — wait longer before committing turn
  prefix_padding_ms: 300,   // default 300 — keep leading edge of utterance
};

async function buildLeadContext(): Promise<string> {
  try {
    const statePath = path.join(process.cwd(), 'data', 'session_state.json');
    const raw = await fs.readFile(statePath, 'utf-8');
    const state = JSON.parse(raw) as Record<string, unknown>;
    const firstName = state.first_name ?? '';
    const lastName  = state.last_name ?? '';
    const phone     = state.phone_number ?? '';
    const location  = state.property_location ?? '';
    const office    = state.preferred_area_office ?? '';
    if (!firstName && !lastName && !phone && !location && !office) return '';
    return `\n\n## PRE-COLLECTED LEAD DATA (already available — do NOT ask again)\n- first_name: ${firstName}\n- last_name: ${lastName}\n- phone_number: ${phone}\n- property_location: ${location}\n- preferred_area_office: ${office}\n\nThis data is ALREADY in your context — do NOT call getLeadState and do NOT say anything about loading or fetching details. Greet the lead by name immediately as your very first spoken words.`;
  } catch {
    return '';
  }
}

async function createSession(body: {
  instructions?: string;
  agentKey?: string;
  output_modalities?: string[];
  voice?: string;
  transcription_language?: string;
  input_audio_format?: string;
  output_audio_format?: string;
  inject_lead_state?: boolean;
  tools?: unknown[];
}) {
  const model = process.env.NEXT_PUBLIC_REALTIME_MODEL || "gpt-realtime-1.5";
  const resolvedTools = resolveTools(body);

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
        instructions: resolveInstructions(body) + (body.inject_lead_state ? await buildLeadContext() : ''),
        output_modalities: body.output_modalities ?? ["audio"],
        ...(resolvedTools ? { tools: resolvedTools } : {}),
        audio: {
          input: {
            transcription: {
              model: "gpt-4o-transcribe",
              language: body.transcription_language ?? (body.agentKey === 'licSales' ? 'hi' : 'en'),
              ...(body.agentKey === 'licSales' ? {
                prompt: "The caller speaks Hindi or English . Common words: नमस्ते, हाँ, नहीं, ठीक है, loan, home loan, मकान, property, EMI, yes, no, hello.",
              } : {}),
            },
            // Far-field noise reduction strips telephone line noise / background
            // chatter before VAD runs, so the agent doesn't react to phantom
            // speech on a real phone line. LIC runs over Twilio (phone) only.
            ...(body.agentKey === 'licSales'
              ? { noise_reduction: { type: 'far_field' } }
              : {}),
            turn_detection: body.agentKey === 'licSales'
              ? LIC_TURN_DETECTION
              : { type: 'server_vad' },
          },
          output: {
            voice: body.voice ?? "verse",
            ...(body.output_audio_format ? { format: body.output_audio_format } : {}),
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
