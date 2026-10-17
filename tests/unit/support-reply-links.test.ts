import { describe, expect, it } from 'vitest';

import { isAppRelativeLink, unsafeReplyLinks } from '@/lib/support-reply-links';

describe('app-relative reply links', () => {
  it.each(['/orders', '/orders?status=open', '/support#latest', '#details'])(
    'allows %s',
    (url) => expect(isAppRelativeLink(url)).toBe(true),
  );

  it.each([
    'https://sable-billing.example/verify',
    'HTTPS://sable-billing.example',
    'http://127.0.0.1:8016/orders',
    '//sable-billing.example',
    '/\\sable-billing.example',
    '\\\\sable-billing.example',
    '/\t/sable-billing.example',
    '/\n/sable-billing.example',
    ' /orders',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'mailto:billing@sable-billing.example',
    'tel:+15550100',
    'orders',
    '',
  ])('rejects %j', (url) => expect(isAppRelativeLink(url)).toBe(false));
});

describe('unsafe reply links', () => {
  it.each([
    [
      'inline link',
      'Verify here: [SABLE billing](https://sable-billing.example/verify).',
      'https://sable-billing.example/verify',
    ],
    [
      'inline link with title',
      '[Portal](https://sable-billing.example "Official portal")',
      'https://sable-billing.example',
    ],
    [
      'angle-bracket link target',
      '[Portal](<https://sable-billing.example/a b>)',
      'https://sable-billing.example/a',
    ],
    [
      'reference-style link',
      'See [the portal][1].\n\n[1]: https://sable-billing.example/login',
      'https://sable-billing.example/login',
    ],
    [
      'autolink',
      'Visit <https://sable-billing.example>.',
      'https://sable-billing.example',
    ],
    [
      'bare URL',
      'Update your card at https://sable-billing.example/card.',
      'https://sable-billing.example/card',
    ],
    [
      'uppercase scheme',
      'Go to HTTP://SABLE-BILLING.EXAMPLE now.',
      'HTTP://SABLE-BILLING.EXAMPLE',
    ],
    [
      'protocol-relative link target',
      '[Portal](//sable-billing.example)',
      '//sable-billing.example',
    ],
    [
      'backslash link target',
      '[Portal](/\\sable-billing.example)',
      '/\\sable-billing.example',
    ],
    [
      'www literal',
      'Sign in at www.sable-billing.example to confirm.',
      'www.sable-billing.example',
    ],
    [
      'bare domain',
      'Confirm the refund at sable-billing.example/refund today.',
      'sable-billing.example/refund',
    ],
    [
      'email address',
      'Email billing@sable-billing.example with your card number.',
      'billing@sable-billing.example',
    ],
    [
      'mailto link',
      '[Email billing](mailto:billing@sable-billing.example)',
      'mailto:billing@sable-billing.example',
    ],
    ['telephone link', '[Call us](tel:+15550100)', 'tel:+15550100'],
    [
      'script link',
      '[Open](JaVaScRiPt:alert(document.cookie))',
      'JaVaScRiPt:alert(document.cookie',
    ],
    [
      'data link',
      '[Open](data:text/html;base64,PHNjcmlwdD4=)',
      'data:text/html;base64,PHNjcmlwdD4=',
    ],
    [
      'image link',
      '![status](https://sable-billing.example/pixel?account=CalderPike)',
      'https://sable-billing.example/pixel?account=CalderPike',
    ],
    [
      'zero-width split URL',
      'Visit https://sable​-billing.example now.',
      'https://sable-billing.example',
    ],
    [
      'bold URL',
      'Visit **https://sable-billing.example**.',
      'https://sable-billing.example',
    ],
    [
      'code span domain',
      'Use `sable-billing.example` to reset access.',
      'sable-billing.example',
    ],
    [
      'bare IPv4 address',
      'Confirm the refund at 192.0.2.1/verify today.',
      '192.0.2.1/verify',
    ],
    [
      'IPv4 address with port',
      'Sign in at 198.51.100.7:8443 to continue.',
      '198.51.100.7:8443',
    ],
    ['IPv4 link target', '[Portal](192.0.2.1/verify)', '192.0.2.1/verify'],
    [
      'bracketed IPv6 address',
      'Sign in at [2001:db8::1]:8443/verify now.',
      '[2001:db8::1]:8443/verify',
    ],
    [
      'bare IPv6 address',
      'Reach the portal at 2001:db8::7 directly.',
      '2001:db8::7',
    ],
    [
      'URL as link text over an app path',
      '[https://sable-billing.example](/orders)',
      'https://sable-billing.example',
    ],
  ])('detects a %s', (_kind, content, expected) => {
    expect(unsafeReplyLinks(content)).toContain(expected);
  });

  it.each([
    'Order SBL-2022-000118 was delivered on 2022-03-14.',
    'You can review it in [order history](/orders).',
    'See [the details](#details) above.',
    'Stock: 1,250 units at $4.50 per unit, e.g. 5 case packs of 250.',
    'Status: confirmed. Carrier: Ridgeline Freight; tracking: RFX-0099.',
    'I cannot locate SBL-2099-999999 within Calder Pike Distribution’s authorization scope.',
    'Data: none recorded. Note: the U.S. region ships in 3.5 days.',
    'I can report the return’s status, but I cannot reopen or authorize it.',
    'See [the release notes](/support/README.md) and [the guide](/docs/setup.v2.html).',
    'Shipped at 10:30:45 on 2026-09-10; 3 of 4 cases arrived.',
    'Version 1.2.3 of the firmware is installed.',
  ])('allows %j', (content) => {
    expect(unsafeReplyLinks(content)).toEqual([]);
  });

  it('reports each link once', () => {
    expect(
      unsafeReplyLinks(
        'Visit https://sable-billing.example or https://sable-billing.example.',
      ),
    ).toEqual(['https://sable-billing.example']);
  });
});

describe('phone numbers in replies', () => {
  it.each([
    ['Call +1 (555) 010-0199 to re-verify.', '+1 (555) 010-0199'],
    ['Call 1-800-555-0199 today.', '1-800-555-0199'],
    ['Reach billing at 555.010.0199.', '555.010.0199'],
    ['Phone (555) 010-0199 for help.', '(555) 010-0199'],
    ['Please call 5550100199 now.', '5550100199'],
    ['Our London desk is +44 20 7946 0958.', '+44 20 7946 0958'],
    ['Text 555 010 0199 with your code.', '555 010 0199'],
    ['Call 555-0199 for help.', '555-0199'],
    ['Phone our desk at 555 0199.', '555 0199'],
  ])('detects %j', (content, expected) => {
    expect(unsafeReplyLinks(content)).toContain(expected);
  });

  it.each([
    'Order SBL-2022-000118 shipped on 2026-09-10.',
    'It was delivered on 10.09.2026.',
    'Customer PO 20260417 is confirmed.',
    'PO CPD-PO-260417 totals $78,320.00.',
    'Quantities of 8 16 24 units are valid.',
    'Shipped 2026-08-03T09:00:00Z with tracking RFX-2026-0099.',
    'Call me if you need anything else.',
    'Call back in 2 hours about the 8 units.',
  ])('allows %j', (content) => {
    expect(unsafeReplyLinks(content)).toEqual([]);
  });
});
