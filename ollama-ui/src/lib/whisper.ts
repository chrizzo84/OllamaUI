// Shared by the Telegram bridge (src/lib/telegram-bridge.ts) and the web
// UI's voice-message endpoint (src/app/api/transcribe/route.ts) — Ollama
// has no speech-to-text model support at all, so both talk to a separate,
// wholly local whisper.cpp `whisper-server` instance instead (see
// WHISPER_HOST; the combined Docker image builds and runs one
// automatically, see the Dockerfile).
import { spawn } from 'node:child_process';

export function getWhisperHost(): string | null {
  return process.env.WHISPER_HOST?.trim().replace(/\/+$/, '') || null;
}

// Converts arbitrary browser/Telegram-recorded audio (WebM/Opus from
// MediaRecorder, OGG/Opus from Telegram voice notes, ...) to the WAV PCM
// whisper.cpp's server expects — via `ffmpeg` over stdin/stdout, no temp
// files. `ffmpeg` auto-detects the input container/codec, so this doesn't
// need to know which one it was actually given. Needs `ffmpeg` on the host
// (bundled in the combined Docker image; on a plain `next dev` checkout,
// install both `ffmpeg` and `whisper-cpp` locally to use this — e.g. `brew
// install ffmpeg whisper-cpp` on macOS).
function convertAudioToWav(audioBytes: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn('ffmpeg', ['-i', 'pipe:0', '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1']);
    } catch (e) {
      reject(e);
      return;
    }
    const chunks: Buffer[] = [];
    let stderr = '';
    proc.stdout.on('data', (c: Buffer) => chunks.push(c));
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    proc.on('error', reject); // e.g. ffmpeg not installed (ENOENT)
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    proc.stdin.write(audioBytes);
    proc.stdin.end();
  });
}

// Posts WAV bytes to a whisper.cpp `whisper-server` instance's `/inference`
// endpoint (multipart, same as its own examples/curl usage — confirmed live
// against whisper-cpp 1.9.2) and returns the transcribed text.
async function transcribeWav(whisperHost: string, wavBytes: Buffer): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(wavBytes)], { type: 'audio/wav' }), 'audio.wav');
  form.append('response_format', 'json');
  const res = await fetch(`${whisperHost}/inference`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`whisper-server request failed: ${res.status}`);
  const data = await res.json();
  const text = typeof data?.text === 'string' ? data.text.trim() : '';
  if (!text) throw new Error('whisper-server returned empty transcription');
  return text;
}

export async function transcribeAudio(whisperHost: string, audioBytes: Buffer): Promise<string> {
  const wav = await convertAudioToWav(audioBytes);
  return transcribeWav(whisperHost, wav);
}
