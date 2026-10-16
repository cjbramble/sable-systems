import { expect } from 'vitest';
import { usdCents } from './context-claims';

type ExpectedField =
  | string
  | { oneOf: readonly string[] }
  | { usdCents: number };

// Only remove paired presentation markers at word boundaries. In particular,
// punctuation inside a number must not turn a malformed amount into a valid one.
function plainField(field: string) {
  expect(field, 'Unexpected presentation marker').not.toContain('\uE000');
  const literals: string[] = [];
  let text = field
    .trim()
    .replace(/^[-+*]\s+/, '')
    .replace(/(?<!`)(`+)(?!`)(.*?)\1(?!`)/g, (_span, _ticks, value: string) => {
      literals.push(value);
      return `\uE000${literals.length - 1}\uE000`;
    });
  let previous: string;
  do {
    previous = text;
    text = text.replace(/(?<!\w)(\*\*|__|[*_])(\S(?:.*?\S)?)\1(?!\w)/g, '$2');
  } while (text !== previous);
  // Code contents are literal, even when the code span itself is emphasized.
  return text.replace(
    /\uE000(\d+)\uE000/g,
    (_token, index: string) => literals[Number(index)],
  );
}

function normalizedText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

// For evaluations that explicitly request one record as label: value fields.
// Consume every field/value; do not extract a correct token from incorrect prose.
export function expectRecordFields(
  answer: string,
  expected: Readonly<Record<string, ExpectedField>>,
) {
  const remaining = new Map(
    Object.entries(expected).map(([label, value]) => [
      normalizedText(label),
      value,
    ]),
  );
  for (const field of answer.split(/[;\r\n]+/).filter((part) => part.trim())) {
    const text = plainField(field);
    const separator = text.indexOf(':');
    expect(separator, `Expected a labeled field: ${field}`).toBeGreaterThan(0);
    const label = normalizedText(text.slice(0, separator));
    const value = text.slice(separator + 1).trim();
    expect(remaining.has(label), `Unknown or repeated field: ${field}`).toBe(
      true,
    );
    const fact = remaining.get(label)!;
    if (typeof fact === 'string') {
      expect(normalizedText(value), field).toBe(normalizedText(fact));
    } else if ('oneOf' in fact) {
      expect(fact.oneOf.map(normalizedText), field).toContain(
        normalizedText(value),
      );
    } else {
      expect(usdCents(value), field).toBe(fact.usdCents);
    }
    remaining.delete(label);
  }
  expect([...remaining.keys()], 'Missing required fields').toEqual([]);
}
