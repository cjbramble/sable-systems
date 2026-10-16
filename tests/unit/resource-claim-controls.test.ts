import { describe, expect, it } from 'vitest';
import { unsupportedSableResources } from '@/lib/support-resource-claims';

describe('resource claim polarity and presentation', () => {
  it.each([
    'Please contact **SABLE Systems** Medical Operations Division.',
    'Please contact _SABLE Systems_ Medical Operations Division.',
    'Please contact `SABLE Systems` Medical Operations Division.',
    'Please contact [SABLE Systems](https://example.com) Medical Operations Division.',
    'Please contact our returns specialist to reopen it.',
    'Our returns specialist can authorize this return.',
    'Ask my service team to approve the order.',
    'I cannot reopen the return, but contact our returns specialist.',
    'The records do not name a SABLE handbook. Contact our returns specialist.',
    'No SABLE handbook is provided; contact our returns specialist.',
    'SABLE Systems Medical Operations Division is not unavailable.',
    'Contact our returns specialist, not an outside professional.',
    'The records do not provide a SABLE handbook, so contact our returns specialist.',
    'No SABLE handbook is provided, contact our returns specialist.',
    'The records do not name our service team; the SABLE returns specialist can help.',
    'The records do not provide a SABLE handbook. SABLE Systems returns specialist can help.',
    'The records provide a hotline; our team is not listed.',
    'The records provide a hotline, but our team is not listed.',
    'The records provide a hotline, and our team is not listed.',
    'I cannot provide help - contact our returns specialist.',
    'Do not contact outsiders - contact our returns specialist.',
    'I cannot provide help please contact our returns specialist.',
  ])('rejects an unverified positive claim: %s', (answer) => {
    expect(unsupportedSableResources(answer).length).toBeGreaterThan(0);
  });

  it.each([
    'The records do not provide a SABLE Systems returns specialist. I cannot reopen or authorize this return.',
    'The records do not provide a **SABLE Systems** returns specialist.',
    'The records do not provide a SABLE Systems **returns specialist**.',
    'No SABLE Systems returns handbook is provided.',
    'I cannot verify a SABLE Systems returns specialist.',
    "I can't refer you to our returns specialist.",
    'SABLE Systems returns handbook is not listed in the records.',
    'The records do not include any returns handbook.',
    'There is no SABLE Systems Medical Operations Division in the records.',
    'Do not contact a SABLE Systems returns specialist; none is verified.',
    'I cannot reopen the return. Consult a qualified professional outside SABLE Systems.',
    'Please consult a licensed medical professional.',
    'No internal contact is provided. I can report the current status.',
    'The records do not name a team; consult an outside specialist.',
    'The records do not name a team, but consult an outside specialist.',
    'The records do not name a team - consult an outside specialist.',
  ])('allows a denial or outside professional: %s', (answer) => {
    expect(unsupportedSableResources(answer)).toEqual([]);
  });

  it('requires explicit resource facts to authorize a name', () => {
    expect(
      unsupportedSableResources(
        'Contact SABLE Systems Medical Operations Division.',
      ),
    ).toEqual(['SABLE Systems Medical Operations Division']);
  });

  it.each([
    'The records name the SABLE Systems returns handbook.',
    'The records provide a returns handbook.',
  ])('preserves verified names in records attribution: %s', (answer) => {
    expect(
      unsupportedSableResources(answer, [{ name: 'Returns handbook' }]),
    ).toEqual([]);
    expect(unsupportedSableResources(answer)).not.toEqual([]);
  });
});
