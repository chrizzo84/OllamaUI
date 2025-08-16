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

const calculator = (args: { expression: string }): { result: number } => {
  const { expression } = z.object({ expression: z.string() }).parse(args);
  const result = calculateExpression(expression);
  return { result };
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


const getDateTime = (args: { part: 'date' | 'time' | 'datetime' }): { result: string } => {
  const { part } = z.object({ part: z.enum(['date', 'time', 'datetime']) }).parse(args);
  const now = new Date();
  switch (part) {
    case 'date':
      return { result: now.toLocaleDateString() };
    case 'time':
      return { result: now.toLocaleTimeString() };
    case 'datetime':
      return { result: now.toLocaleString() };
  }
};


// Export all tools and their schemas
export const tools = {
  calculator,
  get_date_time: getDateTime,
};

export const toolSchemas = [
  calculatorSchema,
  getDateTimeSchema,
];

export type ToolName = keyof typeof tools;
