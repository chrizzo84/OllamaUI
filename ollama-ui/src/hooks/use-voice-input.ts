'use client';
/*
Push-to-talk for the composer: record with the browser's own MediaRecorder,
POST the clip to /api/transcribe (the same whisper.cpp server the Telegram
bridge's voice messages use), and hand back the text.

The transcription is appended to the composer for the user to read and edit
rather than sent straight off — unlike Telegram, there is a visible input box
here, and a misheard word should be caught before it reaches the model.

Extracted from chat-panel.tsx, which had grown to hold the composer, the
attachment handling, the compaction flow, the branch switching and this at
once. Microphone permission, codec selection and releasing the hardware
afterwards are a self-contained problem and read better stated in one place.
*/
import { useCallback, useRef, useState } from 'react';
import { useToastStore } from '@/store/toast';

export interface VoiceInput {
  recording: boolean;
  transcribing: boolean;
  toggleRecording: () => void;
}

export function useVoiceInput(onTranscribed: (text: string) => void): VoiceInput {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const pushToast = useToastStore((s) => s.push);

  const transcribe = useCallback(
    async (blob: Blob) => {
      setTranscribing(true);
      try {
        const form = new FormData();
        form.append('audio', blob, 'voice.webm');
        const res = await fetch('/api/transcribe', { method: 'POST', body: form });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            json.code === 'NO_WHISPER'
              ? 'Voice transcription isn’t set up — WHISPER_HOST is not configured on the server.'
              : json.error || 'Transcription failed',
          );
        }
        const text = typeof json.text === 'string' ? json.text.trim() : '';
        if (!text) {
          pushToast({ type: 'error', message: 'No speech detected in that recording.' });
          return;
        }
        onTranscribed(text);
      } catch (e) {
        pushToast({
          type: 'error',
          message: e instanceof Error ? e.message : 'Transcription failed',
        });
      } finally {
        setTranscribing(false);
      }
    },
    [onTranscribed, pushToast],
  );

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : undefined; // let the browser pick (e.g. Safari has no webm/opus)
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recordedChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        // Release the mic indicator/hardware immediately, don't wait on the
        // (possibly slow) transcription request below.
        stream.getTracks().forEach((t) => t.stop());
        void transcribe(
          new Blob(recordedChunksRef.current, { type: recorder.mimeType || 'audio/webm' }),
        );
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecording(true);
    } catch {
      pushToast({
        type: 'error',
        message: 'Could not access the microphone — check browser/site permissions.',
      });
    }
  }, [pushToast, transcribe]);

  const toggleRecording = useCallback(() => {
    if (recording) {
      mediaRecorderRef.current?.stop();
      setRecording(false);
    } else {
      void startRecording();
    }
  }, [recording, startRecording]);

  return { recording, transcribing, toggleRecording };
}
