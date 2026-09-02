import { NextRequest } from 'next/server';
import { extractDocumentText, formatDocumentContext } from '@/lib/document-extract';

export const runtime = 'nodejs';

/*
POST a file (multipart/form-data, field "file") and get its text back.

The extraction itself (PDF via pdftotext, plain-text-like files read
directly) already existed for the Telegram bridge; only Telegram could reach
it, so you could summarize a PDF from your phone but not from the app the
PDF was sitting next to. This is that same code path, exposed to the
browser.

The text comes back to the client rather than being stored: it is prepended
to the message the user sends, so the document lands in the conversation as
readable context and stays visible in the transcript afterwards, instead of
being invisible state attached to a message.
*/

/*
Refuse implausibly large uploads before reading them into memory. Set to
match Next's own request body cap (experimental.proxyClientMaxBodySize,
10 MB by default) — anything larger never reaches this handler at all, so a
higher number here would be a limit that silently never applies, and the
user would see a confusing parse error instead of a size error.

extractDocumentText caps the *extracted text* separately, which is the limit
that actually protects the model's context window.
*/
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    // Overwhelmingly this is a body that exceeded the platform limit above,
    // which fails during parsing rather than reaching the size check below.
    return Response.json(
      {
        error: `Could not read the upload — it may be larger than the ${Math.floor(
          MAX_UPLOAD_BYTES / 1024 / 1024,
        )} MB limit.`,
      },
      { status: 413 },
    );
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return Response.json({ error: 'No file provided.' }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json(
      {
        error: `"${file.name}" is too large (max ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB).`,
      },
      { status: 413 },
    );
  }

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const text = await extractDocumentText(bytes, file.name, file.type || undefined);
    return Response.json({
      name: file.name,
      characters: text.length,
      context: formatDocumentContext(file.name, text),
    });
  } catch (e) {
    // These messages are written for the person who attached the file
    // ("only PDF and plain-text-like files are supported", "pdftotext is not
    // installed"), so they are passed through rather than replaced.
    const message = e instanceof Error ? e.message : 'Could not read that document.';
    const missingTool = /ENOENT|pdftotext/i.test(message);
    return Response.json(
      {
        error: missingTool
          ? `Could not read "${file.name}": PDF text extraction needs poppler-utils (pdftotext) installed on the server. It is bundled in the Docker image; locally, install it (macOS: brew install poppler).`
          : message,
      },
      { status: 422 },
    );
  }
}
