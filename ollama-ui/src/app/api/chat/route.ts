import { NextRequest } from 'next/server';
import { resolveOllamaHostServer } from '@/lib/host-resolve-server';
import { toolSchemas, tools, ToolName } from '@/lib/tools';
import { getPref } from '@/lib/db';

// Define types for Ollama API structures
interface OllamaMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: OllamaMessage;
  done: boolean;
}

// This type is not used in the new logic but kept for reference
interface UpstreamMessageChunk {
  message?: { content?: string };
  response?: string; // fallback style
  done?: boolean;
  [key: string]: unknown;
}


export const runtime = 'nodejs';

// Helper to transform a non-streaming response into a streaming one
function createStreamableResponse(content: string, model: string): ReadableStream {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      // Stream a single token with the full content
      controller.enqueue(encoder.encode(JSON.stringify({ token: content, model }) + '\n'));
      // Send the done signal with the final cumulative content
      controller.enqueue(encoder.encode(JSON.stringify({ done: true, model, content }) + '\n'));
      controller.close();
    },
  });
}


/*
POST body: { model: string, messages: { role: 'user'|'assistant'|'system', content: string }[] }
Proxy to Ollama /api/chat with tool orchestration, now with multi-hop support.
*/
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const model = (body.model as string | undefined)?.trim();
    const toolsFromClient = body.tools;

    // Get prefs from DB instead of request body
    const searxngUrl = getPref('searxngUrl');
    const searchLimit = Number(getPref('searchLimit') ?? '5');

    if (!model) {
      return new Response(JSON.stringify({ error: 'Missing model' }), { status: 400 });
    }
    const base = resolveOllamaHostServer(req);
    if (!base) {
      return new Response(JSON.stringify({ error: 'No host configured', code: 'NO_HOST' }), {
        status: 428,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let messages: OllamaMessage[] = Array.isArray(body.messages) ? body.messages : [];
    let accumulatedThinkingMessages = '';
    const maxHops = 5;

    for (let i = 0; i < maxHops; i++) {
      const payload = {
        model,
        messages,
        stream: false, // Always non-streaming inside the loop
        ...(i === 0 && toolsFromClient && toolsFromClient.length > 0 && { tools: toolsFromClient }),
      };

      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorText = await res.text();
        const content = accumulatedThinkingMessages + `\n\n**Error from Ollama:**\n\n\`\`\`\n${errorText}\n\`\`\``;
        const transformed = createStreamableResponse(content, model);
        return new Response(transformed, {
          headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
        });
      }

      const responseData: OllamaChatResponse = await res.json();
      const assistantMessage = responseData.message;
      messages.push(assistantMessage);

      let toolCalls: OllamaToolCall[] = [];

      // Check for native tool_calls first
      if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        toolCalls = assistantMessage.tool_calls;
      } else {
        // Check for embedded tool_call in content for multi-hop
        const content = assistantMessage.content;
        const toolCallRegex = /{\s*"tool_call":\s*(\{[\s\S]*?\})\s*}/;
        const match = content.match(toolCallRegex);

        if (match && match[0]) {
          try {
            const parsedToolCall = JSON.parse(match[0]);
            const func = parsedToolCall.tool_call;
            if (func && func.name && func.parameters) {
               toolCalls.push({
                function: { name: func.name, arguments: func.parameters },
              });
            }
          } catch (e) {
            // Ignore if parsing fails, treat as final response
          }
        }
      }

      if (toolCalls.length === 0) {
        // No more tools to call, this is the final answer
        const finalContent = accumulatedThinkingMessages + assistantMessage.content;
        const transformed = createStreamableResponse(finalContent, model);
        return new Response(transformed, {
          headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
        });
      }

      const toolPromises = toolCalls.map(async (toolCall) => {
        const toolName = toolCall.function.name as ToolName;
        const toolArgs = toolCall.function.arguments;

        if (!tools[toolName]) {
          return {
             toolMessage: { role: 'tool', content: JSON.stringify({ error: `Unknown tool: ${toolName}` })},
             thinkingMessage: `<details><summary>Error: Unknown tool ${toolName}</summary></details>\n`
          }
        }

        let toolResult: unknown;
        let thinkingMessage = `<details><summary>Tool: ${toolName}</summary><pre><code>Arguments: ${JSON.stringify(toolArgs, null, 2)}\n`;
        try {
          if (toolName === 'web_search') {
            toolResult = await tools[toolName](toolArgs as any, searxngUrl, searchLimit);
          } else {
            toolResult = await tools[toolName](toolArgs as any);
          }
          thinkingMessage += `Result: ${JSON.stringify(toolResult, null, 2)}</code></pre></details>\n`;
        } catch (e) {
          toolResult = { error: e instanceof Error ? e.message : String(e) };
          thinkingMessage += `Error: ${JSON.stringify(toolResult, null, 2)}</code></pre></details>\n`;
        }

        return {
          toolMessage: { role: 'tool', content: JSON.stringify(toolResult) },
          thinkingMessage,
        };
      });

      const toolExecutionResults = await Promise.all(toolPromises);
      const toolMessages = toolExecutionResults.map(r => r.toolMessage);
      accumulatedThinkingMessages += toolExecutionResults.map(r => r.thinkingMessage).join('');
      messages.push(...toolMessages);
    }

    const finalContent = accumulatedThinkingMessages + "\n\n**Max tool hops reached.**";
    const transformed = createStreamableResponse(finalContent, model);
    return new Response(transformed, {
      headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
    });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Chat failed';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
