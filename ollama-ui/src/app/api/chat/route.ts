import { NextRequest } from 'next/server';
import { resolveOllamaHostServer } from '@/lib/host-resolve-server';
import { toolSchemas, tools, ToolName } from '@/lib/tools';

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
      controller.enqueue(encoder.encode(JSON.stringify({ token: content, model }) + '\n'));
      controller.enqueue(encoder.encode(JSON.stringify({ done: true, model, content }) + '\n'));
      controller.close();
    },
  });
}


/*
POST body: { model: string, messages: { role: 'user'|'assistant'|'system', content: string }[] }
Proxy to Ollama /api/chat with tool orchestration.
*/
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const model = (body.model as string | undefined)?.trim();
    const messages: OllamaMessage[] = Array.isArray(body.messages) ? body.messages : [];

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

    // --- First call to Ollama to check for tool usage ---
    const initialPayload = {
      model,
      messages,
      tools: toolSchemas,
      stream: false, // Tool usage requires stream to be false
    };

    const initialRes = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initialPayload),
    });

    if (!initialRes.ok) {
      const errorText = await initialRes.text();
      return new Response(errorText, { status: initialRes.status });
    }

    const initialData: OllamaChatResponse = await initialRes.json();
    const assistantMessage = initialData.message;

    // Check if the model wants to call a tool
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      // No tool call, just a regular response. Stream it back to the client.
      const transformed = createStreamableResponse(assistantMessage.content, model);
      return new Response(transformed, {
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-cache',
        },
      });
    }

    // --- Tool call requested ---
    const toolCall = assistantMessage.tool_calls[0]; // Assuming one tool call for simplicity
    const toolName = toolCall.function.name as ToolName;
    const toolArgs = toolCall.function.arguments;

    if (!tools[toolName]) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    // Execute the tool
    let toolResult: unknown;
    let thinkingMessage = `<think>Tool: ${toolName}\nArguments: ${JSON.stringify(toolArgs, null, 2)}\n`;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolResult = tools[toolName](toolArgs as any);
      thinkingMessage += `Result: ${JSON.stringify(toolResult, null, 2)}</think>\n`;
    } catch (e) {
      toolResult = { error: e instanceof Error ? e.message : String(e) };
      thinkingMessage += `Error: ${JSON.stringify(toolResult, null, 2)}</think>\n`;
    }

    // --- Second call to Ollama with the tool's result ---
    const messagesWithToolResult: OllamaMessage[] = [
      ...messages,
      assistantMessage, // Include the assistant's message with the tool_calls
      {
        role: 'tool',
        content: JSON.stringify(toolResult),
      },
    ];

    const finalPayload = {
      model,
      messages: messagesWithToolResult,
      stream: true, // Now we can stream the final answer
    };

    const finalRes = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(finalPayload),
    });

    if (!finalRes.body) {
      const txt = await finalRes.text();
      return new Response(txt || JSON.stringify({ error: 'No upstream body' }), {
        status: finalRes.status,
      });
    }

    // --- Stream the final response back to the client ---
    let aggregated = '';
    let lastCumulative = '';
    let thinkingPrepended = false;

    const transformed = new ReadableStream({
      async start(controller) {
        const reader = finalRes.body!.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        function emit(obj: unknown) {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
        }

        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            try {
              const parsed: UpstreamMessageChunk = JSON.parse(line) as UpstreamMessageChunk;
              if (parsed.message && typeof parsed.message.content === 'string') {
                 if (!thinkingPrepended) {
                    parsed.message.content = thinkingMessage + parsed.message.content;
                    thinkingPrepended = true;
                  }
                const cumulative = parsed.message.content;
                let delta = cumulative;
                if (cumulative.startsWith(lastCumulative)) {
                  delta = cumulative.slice(lastCumulative.length);
                }
                aggregated += delta;
                lastCumulative = cumulative;
                if (delta) emit({ token: delta, model });
                if (parsed.done) {
                  emit({ done: true, model, content: aggregated });
                }
              } else {
                emit(parsed);
              }
            } catch {
              emit({ raw: line });
            }
          }
        }
        if (buffer.trim()) emit({ raw: buffer.trim() });
        if (!aggregated) emit({ info: 'empty response', model });
        controller.close();
      },
    });

    return new Response(transformed, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Chat failed';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
