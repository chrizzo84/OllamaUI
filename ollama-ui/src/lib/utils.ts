import { type ClassValue } from 'clsx';
import clsx from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Generate a RFC4122-ish UUID v4 with fallback if crypto.randomUUID is unavailable.
export function safeUuid() {
  const c: (Crypto & { randomUUID?: () => string }) | undefined =
    typeof crypto !== 'undefined' ? (crypto as Crypto & { randomUUID?: () => string }) : undefined;
  if (c?.randomUUID) {
    try {
      return c.randomUUID();
    } catch {
      /* ignore */
    }
  }
  // Fallback: use crypto.getRandomValues if present
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    // Per RFC 4122 section 4.4
    buf[6] = (buf[6] & 0x0f) | 0x40; // version 4
    buf[8] = (buf[8] & 0x3f) | 0x80; // variant
    const hex = Array.from(buf, (b) => b.toString(16).padStart(2, '0'));
    return (
      hex.slice(0, 4).join('') +
      '-' +
      hex.slice(4, 6).join('') +
      '-' +
      hex.slice(6, 8).join('') +
      '-' +
      hex.slice(8, 10).join('') +
      '-' +
      hex.slice(10, 16).join('')
    );
  }
  // Last resort (non-cryptographic)
  return 'id-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
