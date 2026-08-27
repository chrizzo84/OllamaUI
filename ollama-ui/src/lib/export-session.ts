// Client-side conversation export — plain Markdown, built entirely from
// messages already in the store (no server round-trip needed).
import type { ChatMessage } from '@/store/chat';

function formatMessages(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === 'system') {
        return `### Compacted context summary\n\n${m.content}`;
      }
      const label = m.role === 'user' ? 'You' : `Assistant${m.model ? ` (${m.model})` : ''}`;
      return `### ${label}\n\n${m.content || '_(no content)_'}`;
    })
    .join('\n\n');
}

// `columnB` omitted (or empty) means a single-column export — no "Column A/B"
// headers are added in that case, since they'd be noise for the common case.
export function buildSessionMarkdown(
  title: string,
  columnA: ChatMessage[],
  columnB?: ChatMessage[],
): string {
  const parts = [`# ${title}`, `_Exported from Ollama UI on ${new Date().toLocaleString()}_`];
  if (columnB && columnB.length > 0) {
    parts.push('## Column A', formatMessages(columnA));
    parts.push('## Column B', formatMessages(columnB));
  } else {
    parts.push(formatMessages(columnA));
  }
  return parts.filter(Boolean).join('\n\n');
}

export function downloadTextFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Turns a session title into a safe filename stem — keeps it short and
// filesystem-friendly across OSes without pulling in a slugify dependency.
export function slugifyFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'chat';
}
