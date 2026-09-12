import { describe, expect, it } from 'vitest';
import { expectCasePackResponse } from '../assertions/case-pack-response';
import { expectOverlappingComparisonResponse } from '../assertions/product-comparison';
import { expectClaimsToComeFromContext } from '../assertions/context-claims';
import { comparisonContext } from '../fixtures/model-context';
import comparison from '../fixtures/semantic/comparison.json';
import casePack from '../fixtures/semantic/case-pack.json';
import { distributorIdentities } from '../fixtures/users';

// These preauthored examples now inform the factual checkers. Their old holdout
// labels are retained for provenance, not claimed as unseen checker evidence.
describe('live model response assertions', () => {
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
