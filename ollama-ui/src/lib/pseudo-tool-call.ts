// Some models (notably certain fine-tunes) emit a plain-text pseudo tool-call
// syntax for tools the app never declared support for. Ollama doesn't
// recognize this as a structured function call — it just streams through as
// literal content, e.g.:
//
//   <tool_call>
//   <function=web_write>
//   <parameter=path>
//   tetris.html
//   </parameter>
//   <parameter=file_text>
//   ...
//   </parameter>
//   </function>
//   </tool_call>
//
// Detect this so the UI can show something readable instead of raw tags.

const OPEN_TAG = '<tool_call';

export function looksLikePseudoToolCall(text: string): boolean {
  return text.trimStart().startsWith(OPEN_TAG);
}

export interface ParsedPseudoToolCall {
  functionName: string | null;
  parameters: Record<string, string>;
}

export function parsePseudoToolCall(text: string): ParsedPseudoToolCall | null {
  if (!looksLikePseudoToolCall(text)) return null;
  const fnMatch = text.match(/<function=([^>]+)>/);
  const functionName = fnMatch ? fnMatch[1].trim() : null;
  const parameters: Record<string, string> = {};
  const paramRe = /<parameter=([^>]+)>\s*([\s\S]*?)\s*<\/parameter>/g;
  let m: RegExpExecArray | null;
  while ((m = paramRe.exec(text))) {
    parameters[m[1].trim()] = m[2];
  }
  if (!functionName && Object.keys(parameters).length === 0) return null;
  return { functionName, parameters };
}

const CONTENT_PARAM_KEYS = ['file_text', 'content', 'code', 'text'];

const LANG_BY_EXT: Record<string, string> = {
  html: 'html',
  htm: 'html',
  js: 'javascript',
  mjs: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  jsx: 'jsx',
  css: 'css',
  json: 'json',
  py: 'python',
  md: 'markdown',
  sh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
};

function guessLangFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  return (ext && LANG_BY_EXT[ext]) || '';
}

// Turns a parsed pseudo tool-call into markdown: prefer a big content-ish
// parameter (file_text/content/code/text) rendered as a fenced code block,
// falling back to dumping whatever parameters were found.
export function renderPseudoToolCallAsMarkdown(parsed: ParsedPseudoToolCall): string {
  const note = `_The model tried to call an unsupported tool (\`${
    parsed.functionName ?? 'unknown'
  }\`) instead of answering directly — showing its intended output below._`;
  const contentKey = CONTENT_PARAM_KEYS.find((k) => k in parsed.parameters);
  if (contentKey) {
    const body = parsed.parameters[contentKey];
    const pathParam = parsed.parameters.path || parsed.parameters.filename;
    const lang = pathParam ? guessLangFromPath(pathParam) : '';
    const header = pathParam ? `**${pathParam}**\n\n` : '';
    return `${note}\n\n${header}\`\`\`${lang}\n${body}\n\`\`\``;
  }
  const otherKeys = Object.keys(parsed.parameters);
  if (otherKeys.length === 0) return note;
  const paramBlocks = otherKeys
    .map((k) => `**${k}**\n\n\`\`\`\n${parsed.parameters[k]}\n\`\`\``)
    .join('\n\n');
  return `${note}\n\n${paramBlocks}`;
}
