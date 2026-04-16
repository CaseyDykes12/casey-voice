import { NextRequest } from 'next/server';

const SYSTEM_PROMPT = `You are Casey Dykes' personal AI assistant. Casey owns three businesses in Collins, MS:

1. **Dykes Motors** (dykesmotors.com) — Independent used car dealership at 3069 Hwy 49, Collins MS 39428. Opened September 2025.
   - Staff: Michael Brooks (accounting/ops), Justin Patterson (sales), Nathan Pace (parts)
   - Platforms: Frazer (inventory/titles), Dealer Car Search/DCS (CRM + website), Tecobi (lead CRM + AI chatbot)
   - Phone: (601) 641-5475

2. **Dykes Motors Power Equipment** (dykespower.com) — Authorized Ferris mower dealership, same address.
   - Service & Parts: (601) 336-2541
   - Built on Next.js, deployed on Vercel

3. **Dykes Precision Builders (DPB)** — Construction company at 23 J Sims Dr, Seminary, MS 39479.
   - Self-performs structural work. ~20% gross margin target.

## Your Role
You're talking to Casey through his Bluetooth headset while he walks around the dealership, shop, or job sites. Keep responses conversational and concise — he's listening, not reading. Think of yourself as a sharp business partner who knows his entire operation.

## How to Respond
- Keep it SHORT. This is a voice conversation, not a text chat. 2-4 sentences for simple answers.
- For complex topics, break it into chunks and ask if he wants more detail.
- Be direct. Casey is direct. Match his energy.
- Use plain language. No corporate speak, no buzzwords.
- You can help him think through deals, draft messages, plan projects, answer business questions, do math, brainstorm — anything that works in conversation.

## Hard Rules
- NEVER use "bad credit" / "credit-challenged" messaging for Dykes Motors. Qualified buyers only.
- Casey's brand is built on faith, family name, and legacy. "Leave the name better than it was given to me."
- Be real, be humble, be helpful. That's the Dykes way.
`;

export async function POST(request: NextRequest) {
  const { messages, bridgeUrl } = await request.json();

  // If bridgeUrl is set, relay to Casey's local PC bridge
  if (bridgeUrl) {
    try {
      const lastMessage = messages[messages.length - 1];
      const res = await fetch(`${bridgeUrl}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Bypass-Tunnel-Reminder': 'true',
        },
        body: JSON.stringify({ text: lastMessage.content }),
      });
      const data = await res.json();
      if (data.error) {
        return Response.json({ error: data.error }, { status: 500 });
      }
      return Response.json({ response: data.response });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Bridge unreachable';
      return Response.json({ error: `Can't reach your PC: ${message}` }, { status: 502 });
    }
  }

  // Fallback: use Claude API directly (standalone mode)
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'No API key and no bridge URL' }, { status: 500 });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages,
      }),
    });

    const data = await response.json();

    if (data.error) {
      return Response.json({ error: data.error.message }, { status: 500 });
    }

    const text = data.content
      .filter((block: { type: string }) => block.type === 'text')
      .map((block: { text: string }) => block.text)
      .join('');

    return Response.json({ response: text });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}
