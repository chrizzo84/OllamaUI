// Extracts plain text from an uploaded document so its content can be fed
// into the model as context, the same way a transcribed voice message or an
// image already is. Used by both entry points: the Telegram bridge
// (src/lib/telegram-bridge.ts) and the web chat's attach button, via
// src/app/api/documents/extract/route.ts. PDF text extraction goes through `pdftotext` (part of poppler-utils,
// same "shell out to a well-established CLI tool" pattern already used for
// audio via `ffmpeg`/whisper.cpp) — needs to be installed on the host
// (bundled in the combined Docker image; locally, `brew install poppler` on
// macOS). Anything that already looks like plain text (by extension or MIME
// type) is read directly, no extraction needed.
import { spawn } from 'node:child_process';

const TEXT_EXTENSIONS =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|log|ya?ml|xml|html?|css|js|mjs|jsx|ts|tsx|py|rb|go|rs|java|kt|c|cc|cpp|h|hpp|sh|bash|sql|toml|ini|env)$/i;

function looksLikeText(fileName: string, mimeType: string | undefined): boolean {
  if (mimeType?.startsWith('text/')) return true;
  if (mimeType === 'application/json' || mimeType === 'application/xml') return true;
  return TEXT_EXTENSIONS.test(fileName);
}

function extractPdfText(bytes: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      // "-" for both args: read the PDF from stdin, write extracted text to
      // stdout — no temp files, mirrors convertOggToWav's ffmpeg usage.
      proc = spawn('pdftotext', ['-', '-']);
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
    proc.on('error', reject); // e.g. pdftotext/poppler-utils not installed (ENOENT)
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`pdftotext exited ${code}: ${stderr.slice(-300)}`));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    proc.stdin.write(bytes);
    proc.stdin.end();
  });
}

// Hard cap so one huge document can't blow the context window or make the
// prompt itself absurdly expensive — same spirit as memory's 50-fact cap in
// generation-runner.ts. A truncation note is appended so the model (and,
// via the chat trace, you) knows the content isn't complete.
const MAX_CHARS = 20_000;

export async function extractDocumentText(
  bytes: Buffer,
  fileName: string,
  mimeType: string | undefined,
): Promise<string> {
  let text: string;
  if (mimeType === 'application/pdf' || /\.pdf$/i.test(fileName)) {
    text = await extractPdfText(bytes);
  } else if (looksLikeText(fileName, mimeType)) {
    text = bytes.toString('utf-8');
  } else {
    throw new Error(
      `Can't read "${fileName}" (${mimeType || 'unknown type'}) — only PDF and plain-text-like files (.txt, .md, .csv, .json, code, ...) are supported.`,
    );
  }
  text = text.trim();
  if (!text) throw new Error(`"${fileName}" has no extractable text.`);
  if (text.length > MAX_CHARS) {
    text = `${text.slice(0, MAX_CHARS)}\n\n[... truncated, document was ${text.length} characters]`;
  }
  return text;
}

/*
Wraps extracted text in the labelled block that goes into the conversation.

Kept here, next to the extraction, so the browser and the Telegram bridge
present a document to the model identically — a model that has learned what
"[Document: x]" means in one entry point should not meet a different
convention in the other.
*/
export function formatDocumentContext(fileName: string, text: string): string {
  return `[Document: ${fileName}]\n${text}`;
}
