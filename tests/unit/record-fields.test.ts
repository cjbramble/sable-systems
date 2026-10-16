import { describe, expect, it } from 'vitest';
import { expectClaimsToComeFromContext } from '../assertions/context-claims';
import { expectRecordFields } from '../assertions/record-fields';

const fields = {
  'Order ID': 'SBL-2026-000901',
  Status: {
    oneOf: ['partially shipped', 'partially_shipped', 'partially-shipped'],
  },
  'Order total': { usdCents: 123450 },
  'Unit price': { usdCents: 5600 },
};
const answer =
  'Order ID: SBL-2026-000901\nStatus: partially shipped\nOrder total: $1,234.50\nUnit price: $56.00';

describe('labeled record facts', () => {
  it.each([
    answer,
    answer.replaceAll('\n', '; '),
    answer.replaceAll('\n', '\r\n'),
    answer.toUpperCase(),
    answer.replace('partially shipped', 'partially_shipped'),
    answer.replace('partially shipped', 'partially-shipped'),
    answer.replace('$1,234.50', '$1234.5').replace('$56.00', '$56'),
    answer.split('\n').reverse().join('\n'),
    answer
      .split('\n')
      .map((line) => `- **${line}**`)
      .join('\n'),
    answer
      .split('\n')
      .map((line) => `* _${line}_`)
      .join('\n'),
    answer.replace('SBL-2026-000901', '`SBL-2026-000901`'),
    answer.replace('SBL-2026-000901', '**`SBL-2026-000901`**'),
    answer.replace('$1,234.50', '``$1,234.50``'),
    `\n ${answer.replaceAll(': ', ':   ')}\n`,
  ])('accepts equivalent presentation: %s', (text) => {
    expect(() => expectRecordFields(text, fields)).not.toThrow();
  });

  it.each([
    answer
      .replace('$1,234.50', '$56.00')
      .replace('Unit price: $56.00', 'Unit price: $1,234.50'),
    answer.replace('Order total:', 'Subtotal:'),
    answer.replace('Order ID: SBL-2026-000901\n', ''),
    answer.replace('SBL-2026-000901', 'SBL-2026-000902'),
    answer.replace('SBL-2026-000901', 'SBL 2026 000901'),
    answer.replace('SBL-2026-000901', 'SBL_2026_000901'),
    answer.replace('SBL-2026-000901', '`SBL-**2026**-000901`'),
    answer.replace('$1,234.50', '`$**1,234.50**`'),
    answer.replace('$1,234.50', '``$**1,234.50**``'),
    answer.replace('partially shipped', 'not partially shipped'),
    answer.replace('partially shipped', 'never partially shipped'),
    answer.replace('partially shipped', 'delivered'),
    answer.replace('$1,234.50', 'not $1,234.50'),
    answer.replace('$1,234.50', '$1,234.50 for another order'),
    answer.replace('$1,234.50', '$1,234.50 per unit'),
    answer.replace('$1,234.50', '$-1,234.50'),
    answer.replace('$1,234.50', '$1,23,4.50'),
    answer.replace('$1,234.50', '$1,234.500'),
    answer.replace('$1,234.50', '$1,234.51'),
    answer.replace('$1,234.50', '$1,234.50 million'),
    answer.replace('$1,234.50', '$1,234.50 and $56'),
    answer.replace('Unit price: $56.00', 'Unit price: $5_6.00'),
    answer.replace('Unit price: $56.00', 'Unit price: $5*6*.00'),
    `${answer}\nOrder total: $56.00`,
    `${answer}\nOrder total: $1,234.50`,
    `${answer}\nThe order total is actually $56.00.`,
    `${answer}\nIt is not partially shipped.`,
    `${answer}\nOrder ID: SBL-2026-000902`,
    `The following facts are false:\n${answer}`,
    `Not ${answer}`,
    answer.replace('Order total: $1,234.50\n', ''),
    '',
  ])('rejects misplaced, missing, or conflicting facts: %s', (text) => {
    expect(() => expectRecordFields(text, fields)).toThrow();
  });

  it('detects swaps which supplemental context membership accepts', () => {
    const swapped = answer.replace('$1,234.50', '$56.00');
    expect(() => expectClaimsToComeFromContext(swapped, answer)).not.toThrow();
    expect(() => expectRecordFields(swapped, fields)).toThrow();
  });

  it('associates retrieval and update dates with distinct fields', () => {
    const dates = {
      'Item number': 'SBL-RPC-12',
      'Available to promise': '312',
      'Retrieval date': '2026-09-12',
      'Latest update date': '2026-09-02',
    };
    const dated =
      'Item number: SBL-RPC-12\nAvailable to promise: 312\nRetrieval date: 2026-09-12\nLatest update date: 2026-09-02';
    expect(() => expectRecordFields(dated, dates)).not.toThrow();
    for (const wrong of [
      dated.replace('Retrieval date: 2026-09-12', 'Retrieval date: 2026-09-02'),
      dated.replace(
        'Latest update date: 2026-09-02',
        'Latest update date: 2026-09-12',
      ),
      dated.replace('Available to promise: 312', 'Reserved quantity: 312'),
      dated.replace(
        'Available to promise: 312',
        'Available to promise: 312 requested',
      ),
    ]) {
      expect(() => expectClaimsToComeFromContext(wrong, dated)).not.toThrow();
      expect(() => expectRecordFields(wrong, dates)).toThrow();
    }
  });
});
