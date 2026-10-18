// Support records contain no URLs, web addresses, email addresses, or phone
// numbers, so any in a reply came from the model or from customer-authored text
// steering it. Only in-app paths are allowed; the chat view also refuses to link
// anything else.

// Browsers strip tabs and newlines from URLs and treat "\" as "/", so "/\t/x"
// and "/\x" both become protocol-relative. Reject them before the path check.
export function isAppRelativeLink(url: string): boolean {
  if (/[\s\\]/.test(url)) return false;
  for (let index = 0; index < url.length; index += 1) {
    const code = url.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return /^\/(?!\/)/.test(url) || url.startsWith('#');
}

// Zero-width and bidi controls can hide a URL from a plain-text scan.
const INVISIBLE = /[­​-‏‪-‮⁠-⁤﻿]/g;

// Characters that end a URL in prose or Markdown.
const URL_BODY = String.raw`[^\s<>()[\]"'\x60*]+`;

// Broadest first: a later match inside an earlier one is the same link. Each
// capture ends its match, so its position follows from the match length.
const LINK_PATTERNS = [
  // Inline Markdown links and images: [text](target "title").
  /\]\(\s*<?([^)\s>]*)/g,
  // Reference definitions: [label]: target.
  /^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*<?([^\s>]+)/gm,
  // Known schemes with or without "//", in any letter case.
  new RegExp(
    String.raw`\b((?:https?|ftp|file|mailto|tel|sms|javascript|vbscript|data|blob|intent):${URL_BODY})`,
    'gi',
  ),
  // Any other scheme with an authority.
  new RegExp(String.raw`\b([a-z][a-z0-9+.-]*:\/\/${URL_BODY})`, 'gi'),
  // Protocol-relative and backslash-relative hosts.
  /(?:^|[\s(<[])((?:\/\/|\/\\|\\\\)[^\s/\\)>\]]+)/g,
  // GFM autolink literals.
  new RegExp(String.raw`\b(www\.${URL_BODY})`, 'gi'),
  // Email addresses (GFM turns these into mailto: links).
  /([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi,
  // Bare domains such as "sable-billing.example" or "evil.co.uk/login".
  /(?<![\w@.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?:\/[^\s)]*)?)(?![\w-])/gi,
  // IPv4 hosts, with an optional port and path, such as "192.0.2.1:8080/verify".
  /(?<![\w.])((?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:\/[^\s)]*)?)(?![\w.])/g,
  // IPv6 hosts in URL brackets, or bare with "::" or at least five groups, so
  // times such as "10:30:45" do not match.
  /(\[[0-9a-f]*:[0-9a-f]*:[0-9a-f:.]*\](?::\d{1,5})?(?:\/[^\s)]*)?)/gi,
  /(?<![\w:])((?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4})(?![\w:])/gi,
];

function isIpv6Literal(value: string) {
  return value.includes('::') || value.split(':').length >= 6;
}

// Phone numbers: a "+" or "(area)" prefix, or digit groups split by spaces,
// dots, or dashes. A bare run of digits, or a short local number such as
// 555-0199, counts only after a contact word, so quantities and numeric POs
// pass. Each capture ends its match.
const PHONE_PATTERNS = [
  /(?<![\w-])(\+\s?\d[\d\s().-]{5,}\d|\(\d{2,4}\)\s?\d[\d\s.-]{4,}\d|\d{1,4}(?:[ .-]\d{2,4}){2,4})(?![\w-])/g,
  /\b(?:call|phone|dial|text|fax|hotline|telephone|tel|mobile|whatsapp)\b[^.\n\d]{0,24}(\+?\d[\d\s().-]{5,}\d)(?![\w-])/gi,
];

function isPhoneNumber(value: string) {
  const digits = value.replace(/\D/g, '').length;
  // Dates such as 2026-09-10 or 10.09.2026 share the digit-group shape.
  const date =
    /^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/.test(value) ||
    /^\d{1,2}[-./]\d{1,2}[-./]\d{4}$/.test(value);
  return digits >= 7 && digits <= 15 && !date;
}

// Returns each disallowed link, address, or phone number once, in order of
// appearance.
export function unsafeReplyLinks(content: string): string[] {
  const text = content.replace(INVISIBLE, '');
  // Allowed link targets keep their span too, so a dotted in-app path such as
  // "/support/README.md" is not rescanned as the bare domain "README.md".
  const spans: { start: number; end: number; target: string; safe: boolean }[] =
    [];
  for (const pattern of LINK_PATTERNS)
    for (const match of text.matchAll(pattern)) {
      const end = match.index + match[0].length;
      const start = end - (match[1]?.length ?? 0);
      if (spans.some((span) => start >= span.start && end <= span.end))
        continue;
      const target = match[1]?.replace(/[.,;:!?'"*_`]+$/, '');
      if (!target) continue;
      if (/^[0-9a-f:]+$/i.test(target) && !isIpv6Literal(target)) continue;
      spans.push({ start, end, target, safe: isAppRelativeLink(target) });
    }
  for (const pattern of PHONE_PATTERNS)
    for (const match of text.matchAll(pattern)) {
      const end = match.index + match[0].length;
      const target = match[1].trim();
      const start = end - match[1].length;
      if (spans.some((span) => start >= span.start && end <= span.end))
        continue;
      if (isPhoneNumber(target))
        spans.push({ start, end, target, safe: false });
    }
  return [
    ...new Set(
      spans
        .filter(({ safe }) => !safe)
        .toSorted((a, b) => a.start - b.start)
        .map(({ target }) => target),
    ),
  ];
}
