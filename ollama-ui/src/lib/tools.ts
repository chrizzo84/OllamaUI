import { z } from 'zod';

// Helper function for safe calculation
const calculateExpression = (expression: string): number => {
  // Remove all whitespace from the expression
  const sanitizedExpression = expression.replace(/\s+/g, '');

  // Basic validation for allowed characters
  if (!/^[0-9+\-*/().\s]+$/.test(sanitizedExpression)) {
    throw new Error(
      'Invalid characters in expression. Only numbers and operators (+, -, *, /) are allowed.',
    );
  }

  // This is a safer alternative to eval().
  // It uses the Function constructor to evaluate the expression in a restricted scope.
  // It's not perfectly safe, but much better than a direct eval.
  // For a real-world application, a proper parsing library would be best.
  try {
    return new Function(`return ${sanitizedExpression}`)();
  } catch (e) {
    throw new Error('Invalid mathematical expression.');
  }
};


// 1. Calculator Tool
const calculatorSchema = {
  type: 'function',
  function: {
    name: 'calculator',
    description: 'Calculates the result of a mathematical expression.',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'The mathematical expression to evaluate, e.g., "2 + 2" or "(5 - 2) * 3".',
        },
      },
      required: ['expression'],
    },
  },
};

const calculator = async (args: { expression: string }): Promise<{ result: number }> => {
  const { expression } = z.object({ expression: z.string() }).parse(args);
  const result = calculateExpression(expression);
  return Promise.resolve({ result });
};


// 2. Date/Time Tool
const getDateTimeSchema = {
  type: 'function',
  function: {
    name: 'get_date_time',
    description: 'Gets the current date, time, or both.',
    parameters: {
      type: 'object',
      properties: {
        part: {
          type: 'string',
          description: "Specify 'date', 'time', or 'datetime' to get the respective part.",
          enum: ['date', 'time', 'datetime'],
        },
      },
      required: ['part'],
    },
  },
};


const getDateTime = async (
  args: { part: 'date' | 'time' | 'datetime' },
): Promise<{ result: string }> => {
  const { part } = z.object({ part: z.enum(['date', 'time', 'datetime']) }).parse(args);
  const now = new Date();
  let result = '';
  switch (part) {
    case 'date':
      result = now.toLocaleDateString();
      break;
    case 'time':
      result = now.toLocaleTimeString();
      break;
    case 'datetime':
      result = now.toLocaleString();
      break;
  }
  return Promise.resolve({ result });
};


// 3. Web Search Tool
const webSearchSchema = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Searches the web for a given query using a SearXNG instance.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query.',
        },
      },
      required: ['query'],
    },
  },
};

const webSearch = async (
  args: { query: string },
  searxngUrl?: string,
): Promise<{ results: any[] }> => {
  const { query } = z.object({ query: z.string() }).parse(args);

  if (!searxngUrl) {
    throw new Error('SearXNG URL is not configured in settings or passed to the tool.');
  }

  // Use URL constructor for robust URL joining
  const url = new URL(searxngUrl);
  url.pathname = (url.pathname.endsWith('/') ? url.pathname : url.pathname + '/') + 'search';
  url.searchParams.append('q', query);
  url.searchParams.append('format', 'json');

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`SearXNG request failed with status ${response.status}`);
  }

  const data = await response.json();
  // Return a simplified list of results
  return {
    results: data.results.slice(0, 5).map((r: any) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
    })),
  };
};


// Export all tools and their schemas
export const tools = {
  calculator,
  get_date_time: getDateTime,
  web_search: webSearch,
};

export const toolSchemas = [
  calculatorSchema,
  getDateTimeSchema,
  webSearchSchema,
];

export type ToolName = keyof typeof tools;
