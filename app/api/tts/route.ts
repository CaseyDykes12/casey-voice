import { NextRequest } from 'next/server';

// Premium voice chain: ElevenLabs (Casey's own cloned voice) → OpenAI neural
// voice → 501 so the phone falls back to its built-in speech. The app works
// at every tier; each env var just makes it sound better.
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID; // "Casey Dykes PVC" clone
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_flash_v2'; // the ONLY model the PVC fine-tuned on — turbo_v2_5 fine-tune FAILED, renders generic
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const TTS_MODEL = process.env.TTS_MODEL || 'gpt-4o-mini-tts';
const TTS_VOICE = process.env.TTS_VOICE || 'ash'; // warm, natural male voice

async function elevenLabsSpeech(text: string): Promise<Response | null> {
  if (!ELEVEN_KEY || !ELEVEN_VOICE_ID) return null;
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': ELEVEN_KEY,
        },
        body: JSON.stringify({
          text,
          model_id: ELEVEN_MODEL,
          voice_settings: { stability: 0.5, similarity_boost: 0.55, style: 0, use_speaker_boost: true },
        }),
      },
    );
    if (!res.ok) return null; // fall through to OpenAI
    const audio = await res.arrayBuffer();
    return new Response(audio, {
      headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
    });
  } catch {
    return null; // fall through to OpenAI
  }
}

async function openAiSpeech(text: string): Promise<Response> {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: text,
      response_format: 'mp3',
      speed: 1.05,
    }),
  });
  if (!res.ok) {
    return Response.json({ error: 'tts_upstream_error' }, { status: 502 });
  }
  const audio = await res.arrayBuffer();
  return new Response(audio, {
    headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
  });
}

export async function POST(request: NextRequest) {
  if (!ELEVEN_KEY && !OPENAI_KEY) {
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
    const eleven = await elevenLabsSpeech(clean);
    if (eleven) return eleven;
    if (!OPENAI_KEY) {
      return Response.json({ error: 'tts_upstream_error' }, { status: 502 });
    }
    return await openAiSpeech(clean);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'tts_error';
    return Response.json({ error: message }, { status: 500 });
  }
}
