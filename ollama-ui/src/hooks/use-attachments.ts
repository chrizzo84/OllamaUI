'use client';
/*
What the composer is currently carrying: images for a vision model, and
documents whose text has already been extracted server-side.

The two are handled differently on purpose. An image goes to Ollama as
base64 and the model looks at it. A document is turned into text the moment
it is picked (POST /api/documents/extract), so a file that cannot be read
fails immediately next to the attach button rather than silently going
nowhere at send time — and so its content ends up in the message body, where
it stays readable in the transcript afterwards.

Extracted from chat-panel.tsx to keep the composer's state in one place
instead of spread through a 1,400-line component.
*/
import { useCallback, useState } from 'react';
import { useToastStore } from '@/store/toast';

export interface PendingDocument {
  name: string;
  characters: number;
  // The ready-to-prepend "[Document: name]\n..." block; the same layout the
  // Telegram bridge produces, so a model meets one convention, not two.
  context: string;
}

interface PendingImage {
  base64: string;
  // Object URL, for the composer's thumbnail only — revoked on send/remove.
  dataUrl: string;
}

// Ollama's wire format for a message's `images` field is raw base64 with no
// `data:...;base64,` prefix.
function readImageAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function useAttachments() {
  const [images, setImages] = useState<PendingImage[]>([]);
  const [documents, setDocuments] = useState<PendingDocument[]>([]);
  const [extracting, setExtracting] = useState(false);
  const pushToast = useToastStore((s) => s.push);

  /*
  One attach control for everything: images become inline `images`, anything
  else is sent for text extraction. Splitting by type here rather than
  offering two buttons means the user never has to know which kind of
  attachment a given file counts as.
  */
  const attach = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const all = Array.from(files);
      const imageFiles = all.filter((f) => f.type.startsWith('image/'));
      const documentFiles = all.filter((f) => !f.type.startsWith('image/'));

      if (imageFiles.length > 0) {
        try {
          const read = await Promise.all(
            imageFiles.map(async (file) => ({
              base64: await readImageAsBase64(file),
              dataUrl: URL.createObjectURL(file),
            })),
          );
          setImages((prev) => [...prev, ...read]);
        } catch {
          pushToast({ type: 'error', message: 'Could not read one or more images.' });
        }
      }

      if (documentFiles.length === 0) return;
      setExtracting(true);
      try {
        for (const file of documentFiles) {
          const body = new FormData();
          body.append('file', file);
          const res = await fetch('/api/documents/extract', { method: 'POST', body });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            pushToast({ type: 'error', message: data.error || `Could not read "${file.name}".` });
            continue;
          }
          setDocuments((prev) => [
            ...prev,
            { name: data.name, characters: data.characters, context: data.context },
          ]);
        }
      } catch {
        pushToast({ type: 'error', message: 'Could not upload the document.' });
      } finally {
        setExtracting(false);
      }
    },
    [pushToast],
  );

  const removeImage = useCallback((index: number) => {
    setImages((prev) => {
      const removed = prev[index];
      if (removed) URL.revokeObjectURL(removed.dataUrl);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const removeDocument = useCallback((index: number) => {
    setDocuments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  /*
  Hands over what to send and clears the composer.

  The object URLs are released here rather than left to garbage collection:
  they were only ever needed for the thumbnails, and the sent message keeps
  the base64 (which the server then writes to the attachment store).
  */
  const takeAll = useCallback(() => {
    const taken = { images: images.map((i) => i.base64), documents };
    images.forEach((i) => URL.revokeObjectURL(i.dataUrl));
    setImages([]);
    setDocuments([]);
    return taken;
  }, [images, documents]);

  return { images, documents, extracting, attach, removeImage, removeDocument, takeAll };
}
