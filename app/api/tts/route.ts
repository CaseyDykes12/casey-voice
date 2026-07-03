import { NextRequest } from 'next/server';

// Optional high-quality voice. If OPENAI_API_KEY is set in the Vercel env,
// responses are spoken with a natural neural voice. If not, this returns 501
// and the phone falls back to its built-in speech — the app still works either way.
const TTS_MODEL = process.env.TTS_MODEL || 'gpt-4o-mini-tts';
const TTS_VOICE = process.env.TTS_VOICE || 'ash'; // warm, natural male voice

export async function POST(request: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // No premium voice configured — tell the client to use browser speech.
    return Response.json({ error: 'tts_not_configured' }, { status: 501 });
  }

  let text = '';
  try {
    ({ text } = await request.json());
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }

  if (!text || !text.trim()) {
    return Response.json({ error: 'empty' }, { status: 400 });
  }

  // Keep utterances bounded so a runaway reply can't hang playback.
  const clean = text.slice(0, 4000);

  try {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        voice: TTS_VOICE,
        input: clean,
        response_format: 'mp3',
        speed: 1.05,
      }),
    });

    if (!res.ok) {
      return Response.json({ error: 'tts_upstream_error' }, { status: 502 });
    }

    const audio = await res.arrayBuffer();
    return new Response(audio, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'tts_error';
    return Response.json({ error: message }, { status: 500 });
  }
}
