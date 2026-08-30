import { NextRequest } from 'next/server';
import { transcribeAudio, getWhisperHost } from '@/lib/whisper';

export const runtime = 'nodejs';

/*
POST body: multipart/form-data with a single `audio` file field — any
format `ffmpeg` can read (WebM/Opus from the browser's MediaRecorder,
OGG/Opus, WAV, ...). Used by the composer's Voice button
(src/components/chat-panel.tsx) — same whisper.cpp `whisper-server`
(WHISPER_HOST) the Telegram bridge's voice messages already use.

Response: { text: string } on success, { error, code? } otherwise.
*/
export async function POST(req: NextRequest) {
  const whisperHost = getWhisperHost();
  if (!whisperHost) {
    return new Response(
      JSON.stringify({ error: 'No WHISPER_HOST configured', code: 'NO_WHISPER' }),
      { status: 428, headers: { 'Content-Type': 'application/json' } },
    );
  }
  try {
    const form = await req.formData();
    const file = form.get('audio');
    if (!(file instanceof Blob) || file.size === 0) {
      return new Response(JSON.stringify({ error: 'Missing "audio" field' }), { status: 400 });
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const text = await transcribeAudio(whisperHost, bytes);
    return Response.json({ text });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Transcription failed';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
