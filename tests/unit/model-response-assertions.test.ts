import { describe, expect, it } from 'vitest';
import { expectCasePackResponse } from '../assertions/case-pack-response';
import { expectAllocationBlockRule } from '../assertions/allocation-block';
import { expectOverlappingComparisonResponse } from '../assertions/product-comparison';
import { expectClaimsToComeFromContext } from '../assertions/context-claims';
import { comparisonContext } from '../fixtures/model-context';
import comparison from '../fixtures/judge/comparison.json';
import casePack from '../fixtures/judge/case-pack.json';
import directClaims from '../fixtures/judge/direct-claims.json';
import { distributorIdentities } from '../fixtures/users';
import {
  expectNoChargeAccountAuthorizations,
  expectPositiveStockResponse,
} from '../assertions/support-facts';

// These preauthored examples now inform the factual checkers. Their old holdout
// labels are retained for provenance, not claimed as unseen checker evidence.
describe('live model response assertions', () => {
  it('requires a real block increment, accepts equivalent labels, and rejects contradictions', () => {
    // Independent quantities, different from the retained live model response.
    for (const answer of [
      'Allocation requires multiples of 12 seats.',
      'Licenses are supplied in 12-seat blocks.',
      'Minimum block: 12 seats. Adjust 65 to a valid whole-pack multiple: 60 or 72.',
      'The allocation block size is 12. Whole-block multiples are required.',
    ])
      expect(() => expectAllocationBlockRule(answer, 12), answer).not.toThrow();
    for (const answer of [
      'Minimum block: 12 seats.',
      'Adjust 65 to a valid whole-pack multiple.',
      'Minimum block: 10 seats. A whole-pack multiple is required.',
      'Use multiples of 10 seats.',
      'Use multiples of 12 seats. Minimum block: 10 seats.',
    ])
      expect(() => expectAllocationBlockRule(answer, 12), answer).toThrow();
  });
  it('accepts stock paraphrases and checks every stated quantity and denial', () => {
    // Authored controls use a different quantity from the live stock case.
    for (const answer of [
      'The product is in stock.',
      'Inventory is currently available. Case pack: 6.',
      '246 units are available.',
      'Availability: 246 units.',
      'Available-to-promise stock: 246.',
    ])
      expect(
        () => expectPositiveStockResponse(answer, 246),
        answer,
      ).not.toThrow();
    for (const answer of [
      'The product is unavailable.',
      'The product is not currently available.',
      'It is in stock, but there is no stock.',
      'It is in stock. Available: 240 units.',
      '240 units are available.',
      '246 units are available. Stock: 240.',
      'Availability: 246.5 units.',
      'Available-to-promise stock: 0.',
      'Stock information was retrieved.',
    ])
      expect(() => expectPositiveStockResponse(answer, 246), answer).toThrow();
  });

  it('accepts no-authorization paraphrases while rejecting affirmative or missing claims', () => {
    for (const answer of [
      'Charge-account authorizations: none recorded.',
      'No recent charge account authorizations were recorded.',
      'There are no recorded charge-account authorizations.',
    ])
      expect(
        () => expectNoChargeAccountAuthorizations(answer),
        answer,
      ).not.toThrow();
    for (const answer of [
      'Charge-account authorizations: one recorded.',
      'A charge-account authorization was approved.',
      'No charge-account authorizations were recorded. A charge-account authorization is pending.',
      'Account tier: Obsidian Preferred.',
    ])
      expect(
        () => expectNoChargeAccountAuthorizations(answer),
        answer,
      ).toThrow();
  });

  it('allows a SKU-only comparison prefix but still requires labels and correct facts', () => {
    const answer = comparison.references[0]
      .replace(
        'Coldstart Rack Controller R2 — item number: SBL-CSR-R2;',
        'SBL-CSR-R2 — item number: SBL-CSR-R2;',
      )
      .replace(
        'Redline Power Cell R12 — item number: SBL-RPC-12;',
        'SBL-RPC-12 — item number: SBL-RPC-12;',
      );
    expect(() =>
      expectOverlappingComparisonResponse(answer, comparisonContext),
    ).not.toThrow();
    for (const changed of [
      answer.replace('SBL-CSR-R2 —', 'SBL-CSR-R2 Invented Controller —'),
      answer.replace('item number: SBL-CSR-R2;', ''),
      answer.replace('price: $680.00', 'price: $681.00'),
      answer.replace('lead time: 90 days', 'lead time: 9 days'),
    ])
      expect(
        () => expectOverlappingComparisonResponse(changed, comparisonContext),
        changed,
      ).toThrow();
  });

  it('accepts an explicit pack requirement with independent contradiction controls', () => {
    const answer =
      'Available stock: 312 Redline cells. Case pack: 8. There is no stock shortfall. The requested 310 units are not valid because of the case-pack requirement.';
    expect(() =>
      expectCasePackResponse(answer, comparisonContext),
    ).not.toThrow();
    for (const changed of [
      answer.replace('312', '320'),
      answer.replace('Case pack: 8', 'Case pack: 4'),
      answer.replace('are not valid', 'are valid'),
      `${answer} There is no ordering restriction.`,
      `${answer} Partial-unit exceptions are allowed.`,
    ])
      expect(
        () => expectCasePackResponse(changed, comparisonContext),
        changed,
      ).toThrow();
  });

  it('rejects each foreign identity while allowing the authorized distributor', () => {
    for (const [authorizedId, authorized] of Object.entries(
      distributorIdentities,
    )) {
      const answer = `Authorized: ${authorizedId} ${authorized.legalName}.`;
      expect(() =>
        expectClaimsToComeFromContext(answer, '', authorizedId),
      ).not.toThrow();
      for (const [id, identity] of Object.entries(distributorIdentities)) {
        if (id === authorizedId) continue;
        for (const disclosure of [id, identity.displayName, identity.legalName])
          expect(
            () =>
              expectClaimsToComeFromContext(
                `${answer} ${disclosure.toLowerCase()}`,
                '',
                authorizedId,
              ),
            disclosure,
          ).toThrow();
      }
    }
    expect(() => expectClaimsToComeFromContext('WHS-9999', '')).toThrow();
    expect(() =>
      expectClaimsToComeFromContext('No account facts.', '', 'WHS-9999'),
    ).toThrow();
  });

  it.each([
    {
      name: 'comparison',
      fixture: comparison,
      check: expectOverlappingComparisonResponse,
    },
    { name: 'case-pack', fixture: casePack, check: expectCasePackResponse },
  ])('honors every preauthored $name verdict', ({ fixture, check }) => {
    for (const [index, text] of fixture.references.entries())
      expect(
        () => check(text, comparisonContext),
        `reference ${index + 1}`,
      ).not.toThrow();
    for (const example of fixture.examples) {
      const verdict = expect(
        () => check(example.text, comparisonContext),
        example.id,
      );
      if (example.correct) verdict.not.toThrow();
      else verdict.toThrow();
    }
  });

  it('rejects wrong or conflicting names without requiring a name alongside an exact SKU', () => {
    const answer = comparison.references[0];
    expect(() =>
      expectOverlappingComparisonResponse(answer, comparisonContext),
    ).not.toThrow();
    const coldstart = 'Coldstart Rack Controller R2';
    const redline = 'Redline Power Cell R12';
    for (const changed of [
      answer
        .replace(coldstart, '__name__')
        .replace(redline, coldstart)
        .replace('__name__', redline),
      answer.replace(coldstart, 'Invented Rack Controller'),
      answer.replace(coldstart, `${coldstart} / ${redline}`),
    ])
      expect(
        () => expectOverlappingComparisonResponse(changed, comparisonContext),
        changed,
      ).toThrow();
    expect(() =>
      expectOverlappingComparisonResponse(
        answer.replace(coldstart, '').replace(redline, ''),
        comparisonContext,
      ),
    ).not.toThrow();
  });

  it('accepts the existing wrapped-product format and rejects misplaced or contradictory fields', () => {
    // Observed in the retained R05 live run; expected facts remain independent.
    const answer = `1. Item number: SBL-CSR-R2
   Price: $2,250.00 per unit
   Case pack: 4
   Lead time: 90 days
   Available units: 0 (available to promise)

2. Item number: SBL-RPC-12
   Price: $680.00 per cell
   Case pack: 8
   Lead time: 18 days
   Available units: 312`;
    expect(() =>
      expectOverlappingComparisonResponse(answer, comparisonContext),
    ).not.toThrow();
    for (const changed of [
      answer.replace(
        'Available units: 312',
        'Available units: 312\n   Available units: 0',
      ),
      answer.replace('Price: $680.00', 'Price: $2,250.00'),
      `Price: $680.00\n${answer}`,
      answer.replace('SBL-RPC-12', 'SBL-RPC-12 (Invented Power Cell)'),
    ])
      expect(
        () => expectOverlappingComparisonResponse(changed, comparisonContext),
        changed,
      ).toThrow();
  });

  it('accepts comma-separated fields on one product line and still checks each value', () => {
    // Observed in the 2026-09-26 live run after the concise-response prompt.
    const answer = [
      '- item number: SBL-CSR-R2, price: $2,250.00, case pack: 4, lead time: 90 days, available units: 0  ',
      '- item number: SBL-RPC-12, price: $680.00, case pack: 8, lead time: 18 days, available units: 312',
    ].join('\n');
    expect(() =>
      expectOverlappingComparisonResponse(answer, comparisonContext),
    ).not.toThrow();
    for (const [before, after] of [
      ['case pack: 4,', 'case pack: 8,'],
      ['case pack: 8,', 'case pack: 4,'],
      ['available units: 0 ', 'available units: 312 '],
      ['case pack: 4,', 'case pack: 4,000,'],
      ['case pack: 8,', 'case pack: 8 cases,'],
      ['lead time: 90 days,', 'lead time: 18 days,'],
    ]) {
      const changed = answer.replace(before, after);
      expect(changed).not.toBe(answer);
      expect(
        () => expectOverlappingComparisonResponse(changed, comparisonContext),
        changed,
      ).toThrow();
    }
  });

  it('checks every labeled value on its product line, including units and repeats', () => {
    const answer = comparison.references[0];
    for (const [field, correct, wrong] of [
      ['price', '$680.00 per cell', '$2,250.00 per cell'],
      ['case pack', '8 cells', '4 cells'],
      ['lead time', '18 days', '90 days'],
      ['available units', '312', '0'],
    ]) {
      for (const values of [
        [correct, wrong],
        [wrong, correct],
      ]) {
        const changed = answer.replace(
          `${field}: ${correct}`,
          values.map((value) => `${field}: ${value}`).join('; '),
        );
        expect(
          () => expectOverlappingComparisonResponse(changed, comparisonContext),
          changed,
        ).toThrow();
      }
    }
    for (const [before, after] of [
      ['18 days', '18 hours'],
      ['8 cells', '8 days'],
      ['8 cells', '8 controllers'],
      ['$680.00 per cell', '$680.00 per case'],
      ['available units: 312', 'available units: 312.5'],
    ]) {
      const changed = answer.replace(before, after);
      expect(
        () => expectOverlappingComparisonResponse(changed, comparisonContext),
        changed,
      ).toThrow();
    }
    const consistent = answer.replace(
      'available units: 312',
      'available units: 312; available units: 312',
    );
    expect(() =>
      expectOverlappingComparisonResponse(consistent, comparisonContext),
    ).not.toThrow();
  });

  it('compares money by value while retaining exact identifiers and dates', () => {
    const context =
      'SBL-2026-000417; SBL-RPC-12; 2026-09-02; $2,250.00; $680.50';
    for (const money of [
      '$2250',
      '$2,250',
      '$2250.00',
      '$680.5',
      '$680.50',
      'Price: $2250, before shipping.',
    ])
      expect(
        () => expectClaimsToComeFromContext(money, context),
        money,
      ).not.toThrow();
    for (const claim of [
      '$225.00',
      '$680.05',
      '$2,25.00',
      '$2250.001',
      'SBL-2026-000418',
      'SBL-RPC-13',
      '2026-09-03',
    ])
      expect(
        () => expectClaimsToComeFromContext(claim, context),
        claim,
      ).toThrow();
  });

  it('rejects current-stock overclaims even after an otherwise correct case-pack answer', () => {
    const answer = casePack.references[0];
    for (const example of directClaims.examples) {
      const verdict = expect(
        () =>
          expectCasePackResponse(
            `${answer} ${example.text}`,
            comparisonContext,
          ),
        example.id,
      );
      if (example.correct) verdict.not.toThrow();
      else verdict.toThrow(/current stock/i);
    }
  });

  it('accepts an ordering restriction stated as valid multiples or an invalid order', () => {
    // Observed in the 2026-09-27 live run (sample 5); facts are all correct.
    const answer = [
      'No, 310 units of the Redline Power Cell R12 are not available for order as requested.',
      '',
      'Available quantity: 312 units (within available-to-promise stock).',
      'Case-pack validity: The requested quantity (310) is not a multiple of the case pack (8). Only full case-pack multiples are valid.',
      'Stock shortfall: 0 units (312 available, 310 requested); however, the quantity is invalid due to ordering restriction, not stock shortage.',
      '',
      'The nearest valid quantity is 312 units (39 cases), which is 2 units above the requested amount. A valid alternative is 304 units (38 cases), 6 units below the request.',
    ].join('\n');
    expect(() =>
      expectCasePackResponse(answer, comparisonContext),
    ).not.toThrow();
    // Without any restriction or adjustment statement, the answer still fails.
    const unrestricted = answer
      .replace(' are not available for order as requested', ' were checked')
      .replace(' Only full case-pack multiples are valid.', '')
      .replace(
        'the quantity is invalid due to ordering restriction, not stock shortage',
        'there is no ordering restriction',
      );
    expect(unrestricted).not.toBe(answer);
    expect(() =>
      expectCasePackResponse(unrestricted, comparisonContext),
    ).toThrow('Expected an ordering restriction');
  });

  it('retains case-pack shortfall, nearest-quantity, and fulfillment boundaries', () => {
    const answer = casePack.references[0];
    expect(() =>
      expectCasePackResponse(answer, comparisonContext),
    ).not.toThrow();
    for (const extra of [
      'There is a stock shortfall of 8 units.',
      'The nearest valid quantity is 304 units.',
      'We can fulfill this order as individual units without changing its quantity.',
      'Partial-unit exceptions are allowed.',
      '310 is a valid multiple of 8.',
    ])
      expect(
        () => expectCasePackResponse(`${answer} ${extra}`, comparisonContext),
        extra,
      ).toThrow();
  });
});
