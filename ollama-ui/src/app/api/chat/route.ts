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
    const toolsFromClient = body.tools;
    const searxngUrl = body.searxngUrl;
    const searchLimit = body.searchLimit;

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
      ...(toolsFromClient && toolsFromClient.length > 0 && { tools: toolsFromClient }),
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

    // --- Tool calls requested ---
    const toolCalls = assistantMessage.tool_calls;

    const toolPromises = toolCalls.map(async (toolCall) => {
      const toolName = toolCall.function.name as ToolName;
      const toolArgs = toolCall.function.arguments;

      if (!tools[toolName]) {
        throw new Error(`Unknown tool: ${toolName}`);
      }

      let toolResult: unknown;
      let thinkingMessage = `<details><summary>Tool: ${toolName}</summary><pre><code>Arguments: ${JSON.stringify(
        toolArgs,
        null,
        2,
      )}\n`;

      try {
        if (toolName === 'web_search') {
          toolResult = await tools[toolName](toolArgs as any, searxngUrl, searchLimit);
        } else {
          toolResult = await tools[toolName](toolArgs as any);
        }
        thinkingMessage += `Result: ${JSON.stringify(toolResult, null, 2)}</code></pre></details>\n`;
      } catch (e) {
        toolResult = { error: e instanceof Error ? e.message : String(e) };
        thinkingMessage += `Error: ${JSON.stringify(
          toolResult,
          null,
          2,
        )}</code></pre></details>\n`;
      }

      return {
        toolMessage: {
          role: 'tool',
          content: JSON.stringify(toolResult),
        },
        thinkingMessage,
      };
    });

    const toolResults = await Promise.all(toolPromises);
    const toolMessages = toolResults.map(r => r.toolMessage);
    const thinkingMessage = toolResults.map(r => r.thinkingMessage).join('');


    // --- Second call to Ollama with the tool's result ---
    const messagesWithToolResult: OllamaMessage[] = [
      ...messages,
      assistantMessage, // Include the assistant's message with the tool_calls
      ...toolMessages,
    ];

    const finalPayload = {
      model,
      messages: messagesWithToolResult,
      stream: false, // Let's see what we get with a non-streaming request
    };

    const finalRes = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(finalPayload),
    });

    if (!finalRes.ok) {
      const errorText = await finalRes.text();
      // Prepend the thinking message to the error so we can see it
      const content = thinkingMessage + `\n\n**Error from Ollama:**\n\n\`\`\`\n${errorText}\n\`\`\``;
      const transformed = createStreamableResponse(content, model);
      return new Response(transformed, {
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-cache',
        },
      });
    }

    const finalData: OllamaChatResponse = await finalRes.json();
    const finalContent = finalData.message.content;

    // Prepend the thinking message to the final content
    const contentWithThinking = thinkingMessage + finalContent;

    const transformed = createStreamableResponse(contentWithThinking, model);

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
