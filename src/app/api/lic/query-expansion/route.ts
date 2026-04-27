import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const { query } = await req.json();
    if (!query) {
      return NextResponse.json({ error: 'Query is required' }, { status: 400 });
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: `You are a query expansion assistant for a LICHFL (LIC Housing Finance) home loan knowledge base.
The knowledge base covers: eligibility, documents, interest rates, EMI calculation, repayment tenure, loan security/collateral, prepayment/foreclosure, and tax benefits.
Given a user query (which may be in Hindi, Hinglish, or English), extract English keyword search terms that will best match relevant articles in the knowledge base.
If the user query is in Hindi or Hinglish, translate it to English and extract keywords from the translation.
Return ONLY a JSON array of lowercase English strings. No explanation, no markdown, just the JSON array.
Example: ["interest rate", "processing fees", "floating rate"]`,
          },
          {
            role: 'user',
            content: query,
          },
        ],
      }),
    });

    if (!response.ok) {
      return NextResponse.json({ error: `OpenAI API error: ${response.status}` }, { status: response.status });
    }

    const json = await response.json();
    const content: string = json.choices?.[0]?.message?.content?.trim() ?? '[]';
    const parsed = JSON.parse(content);
    return NextResponse.json({ terms: Array.isArray(parsed) ? parsed : [] });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Query expansion failed' }, { status: 500 });
  }
}
