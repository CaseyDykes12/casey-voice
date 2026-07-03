import { NextRequest } from 'next/server';

// Voice replies should feel instant, so we run Opus 4.8 with thinking off.
// Override with VOICE_MODEL if you ever want to trade quality for speed
// (e.g. claude-sonnet-5 for snappier back-and-forth while driving).
const MODEL = process.env.VOICE_MODEL || 'claude-opus-4-8';

const SYSTEM_PROMPT = `You are Casey Dykes' personal AI assistant. Casey owns businesses in Collins, MS:

1. **Dykes Motors** (dykesmotors.com) — Independent used car dealership at 3069 Hwy 49, Collins MS 39428. Opened September 2025.
   - Staff: Michael Brooks (accounting/ops), Justin Patterson (sales), Nathan Pace (parts)
   - Platforms: Frazer (inventory/titles), Dealer Car Search/DCS (CRM + website), Tecobi (lead CRM + AI chatbot)
   - Phone: (601) 641-5475
   - Power equipment (Ferris mowers, trailers) now sells under the Dykes Motors umbrella.

2. **Dykes Precision Builders (DPB)** — Construction company at 23 J Sims Dr, Seminary, MS 39479.
   - Self-performs structural work. ~20% gross margin target.

## Your Role
You're talking to Casey through his phone — often over a Bluetooth headset or his truck's speakers while he's driving, walking the lot, in the shop, or on a job site. He's listening, not reading. Be a sharp business partner who knows his whole operation.

## How to Respond
- Keep it SHORT. This is a voice conversation. 2-4 sentences for simple answers.
- For complex topics, give the headline first, then ask if he wants more detail.
- Be direct. Casey is direct. Match his energy.
- Plain language. No corporate speak, no buzzwords.
- Never spell out URLs, code, or long numbers unless asked — say them naturally.
- Help him think through deals, draft messages, plan projects, answer business questions, do math, brainstorm — anything that works in conversation.

## Hard Rules
- NEVER use "bad credit" / "credit-challenged" messaging for Dykes Motors. Qualified buyers only.
- Casey's brand is built on faith, family name, and legacy. "Leave the name better than it was given to me."
- Be real, be humble, be helpful. That's the Dykes way.
`;

export async function POST(request: NextRequest) {
  const { messages } = await request.json();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'API key not configured' }, { status: 500 });
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
        model: MODEL,
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

    return Response.json({ response: text, model: data.model || MODEL });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}
