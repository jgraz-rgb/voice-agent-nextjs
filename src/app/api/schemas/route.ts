import { NextRequest, NextResponse } from 'next/server';
import { allAgentSets } from '@/app/agentConfigs';

// Returns OpenAI-format tool schemas for a given agentKey.
// Used by the phone-call server (media-stream.ts) to register tools when
// creating an OpenAI Realtime session via the external backend — the external
// backend doesn't have schemas for locally-defined agents like aaaInsurance.
export async function GET(req: NextRequest) {
  const agentKey = req.nextUrl.searchParams.get('agentKey');
  if (!agentKey) {
    return NextResponse.json({ error: 'agentKey required' }, { status: 400 });
  }

  const agents = allAgentSets[agentKey];
  if (!agents?.length) {
    return NextResponse.json({ tools: [] });
  }

  const tools = agents[0]?.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    return NextResponse.json({ tools: [] });
  }

  const schemas = tools
    .filter((t: any) => t.type === 'function' && t.name && t.parameters)
    .map((t: any) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description ?? '',
      parameters: t.parameters,
    }));

  return NextResponse.json({ tools: schemas });
}
