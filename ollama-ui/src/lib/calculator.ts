// A small, hand-rolled arithmetic expression evaluator for the calculator
// tool (src/app/api/chat/route.ts) — deliberately NOT eval()/new Function():
// this runs server-side against model-supplied input, so arbitrary code
// execution is not an option. The tokenizer only ever recognizes digits,
// '.', and a fixed set of operator/paren characters; anything else throws
// before any evaluation happens, so there's no path to executing arbitrary
// JS regardless of what the model passes in.
const MAX_EXPRESSION_LENGTH = 200;

type Token = { type: 'num'; value: number } | { type: 'op'; value: string };

const OPERATOR_CHARS = '+-*/%^()';

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i + 1;
      while (j < expr.length && /[0-9.]/.test(expr[j])) j++;
      const numStr = expr.slice(i, j);
      const value = Number(numStr);
      if (!Number.isFinite(value)) throw new Error(`Invalid number: "${numStr}"`);
      tokens.push({ type: 'num', value });
      i = j;
      continue;
    }
    if (OPERATOR_CHARS.includes(c)) {
      tokens.push({ type: 'op', value: c });
      i++;
      continue;
    }
    throw new Error(`Unexpected character in expression: "${c}"`);
  }
  return tokens;
}

// Recursive-descent parser, standard precedence: ^ (right-assoc) > unary +/-
// > * / % > + -. Grammar:
//   addSub  := mulDiv (('+'|'-') mulDiv)*
//   mulDiv  := power (('*'|'/'|'%') power)*
//   power   := unary ('^' power)?
//   unary   := ('-'|'+') unary | primary
//   primary := number | '(' addSub ')'
export function evaluateExpression(expr: string): number {
  if (expr.length > MAX_EXPRESSION_LENGTH) {
    throw new Error(`Expression too long (max ${MAX_EXPRESSION_LENGTH} characters)`);
  }
  const tokens = tokenize(expr);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (t: Token | undefined, ...vals: string[]) =>
    !!t && t.type === 'op' && vals.includes(t.value);

  function parsePrimary(): number {
    const t = peek();
    if (!t) throw new Error('Unexpected end of expression');
    if (isOp(t, '(')) {
      pos++;
      const v = parseAddSub();
      if (!isOp(peek(), ')')) throw new Error('Missing closing parenthesis');
      pos++;
      return v;
    }
    if (t.type === 'num') {
      pos++;
      return t.value;
    }
    throw new Error(`Unexpected token: "${t.value}"`);
  }

  function parseUnary(): number {
    const t = peek();
    if (isOp(t, '-')) {
      pos++;
      return -parseUnary();
    }
    if (isOp(t, '+')) {
      pos++;
      return parseUnary();
    }
    return parsePrimary();
  }

  function parsePower(): number {
    const base = parseUnary();
    if (isOp(peek(), '^')) {
      pos++;
      return Math.pow(base, parsePower()); // right-associative
    }
    return base;
  }

  function parseMulDiv(): number {
    let v = parsePower();
    while (isOp(peek(), '*', '/', '%')) {
      const op = (peek() as { type: 'op'; value: string }).value;
      pos++;
      const rhs = parsePower();
      if (op === '*') v *= rhs;
      else if (op === '/') {
        if (rhs === 0) throw new Error('Division by zero');
        v /= rhs;
      } else {
        if (rhs === 0) throw new Error('Division by zero');
        v %= rhs;
      }
    }
    return v;
  }

  function parseAddSub(): number {
    let v = parseMulDiv();
    while (isOp(peek(), '+', '-')) {
      const op = (peek() as { type: 'op'; value: string }).value;
      pos++;
      const rhs = parseMulDiv();
      v = op === '+' ? v + rhs : v - rhs;
    }
    return v;
  }

  const result = parseAddSub();
  if (pos < tokens.length) {
    throw new Error(`Unexpected trailing input near "${(peek() as Token).value}"`);
  }
  if (!Number.isFinite(result)) throw new Error('Result is not a finite number');
  return result;
}
