import { describe, it, expect } from 'vitest';
import { evaluateExpression } from './calculator';

describe('evaluateExpression', () => {
  describe('basic arithmetic', () => {
    it.each([
      ['1+1', 2],
      ['10-3', 7],
      ['6*7', 42],
      ['10/4', 2.5],
      ['10%3', 1],
      ['2^10', 1024],
      ['  7  +  3  ', 10],
      ['3.5*2', 7],
      ['.5+.25', 0.75],
    ])('evaluates %s', (expr, expected) => {
      expect(evaluateExpression(expr)).toBe(expected);
    });
  });

  describe('precedence and associativity', () => {
    it('multiplies before adding', () => {
      expect(evaluateExpression('2+3*4')).toBe(14);
    });

    it('honours parentheses over precedence', () => {
      expect(evaluateExpression('(2+3)*4')).toBe(20);
    });

    it('subtracts left-associatively', () => {
      expect(evaluateExpression('10-3-2')).toBe(5);
    });

    it('divides left-associatively', () => {
      expect(evaluateExpression('100/5/2')).toBe(10);
    });

    it('exponentiates right-associatively', () => {
      expect(evaluateExpression('2^3^2')).toBe(512); // 2^(3^2), not (2^3)^2 = 64
    });

    it('binds ^ tighter than unary minus', () => {
      // Regression: this used to return 4 because the parser folded the
      // minus into the base before exponentiating. -2^2 is -(2^2).
      expect(evaluateExpression('-2^2')).toBe(-4);
    });

    it('still allows a negative exponent', () => {
      expect(evaluateExpression('2^-3')).toBe(0.125);
    });

    it('applies unary minus to a parenthesised base normally', () => {
      expect(evaluateExpression('(-2)^2')).toBe(4);
    });

    it('binds ^ tighter than multiplication', () => {
      expect(evaluateExpression('3*2^3')).toBe(24);
    });

    it('handles a unary minus after an operator', () => {
      expect(evaluateExpression('5*-2')).toBe(-10);
    });

    it('handles stacked unary operators', () => {
      expect(evaluateExpression('--5')).toBe(5);
      expect(evaluateExpression('-+-5')).toBe(5);
    });

    it('handles nested parentheses', () => {
      expect(evaluateExpression('((2+3)*(4-1))^2')).toBe(225);
    });
  });

  describe('rejects bad input instead of evaluating it', () => {
    it('refuses arbitrary identifiers (no eval path)', () => {
      // The whole point of the hand-rolled parser: model-supplied input
      // must never reach anything that can execute code.
      expect(() => evaluateExpression('process.exit(1)')).toThrow(/Unexpected character/);
      expect(() => evaluateExpression('require("fs")')).toThrow(/Unexpected character/);
      expect(() => evaluateExpression('globalThis')).toThrow(/Unexpected character/);
    });

    it('rejects unknown characters', () => {
      expect(() => evaluateExpression('2 & 3')).toThrow(/Unexpected character/);
    });

    it('rejects an unterminated parenthesis', () => {
      expect(() => evaluateExpression('(1+2')).toThrow(/Missing closing parenthesis/);
    });

    it('rejects trailing input', () => {
      expect(() => evaluateExpression('1+2)')).toThrow(/trailing input/);
    });

    it('rejects an empty expression', () => {
      expect(() => evaluateExpression('')).toThrow(/Unexpected end of expression/);
    });

    it('rejects a dangling operator', () => {
      expect(() => evaluateExpression('1+')).toThrow(/Unexpected end of expression/);
    });

    it('rejects division by zero', () => {
      expect(() => evaluateExpression('1/0')).toThrow(/Division by zero/);
    });

    it('rejects modulo by zero', () => {
      expect(() => evaluateExpression('1%0')).toThrow(/Division by zero/);
    });

    it('rejects a malformed number', () => {
      expect(() => evaluateExpression('1.2.3')).toThrow(/Invalid number/);
    });

    it('rejects an over-long expression before parsing it', () => {
      expect(() => evaluateExpression('1+'.repeat(200) + '1')).toThrow(/too long/);
    });

    it('rejects a non-finite result', () => {
      expect(() => evaluateExpression('9^9^9')).toThrow(/not a finite number/);
    });
  });
});
