// Support records contain no URLs, web addresses, or email addresses, so any in a
// reply came from the model or from customer-authored text steering it. Only
// in-app paths are allowed; the chat view also refuses to link anything else.

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
];

// Returns each disallowed link or address once, in order of appearance.
export function unsafeReplyLinks(content: string): string[] {
  const text = content.replace(INVISIBLE, '');
  const spans: { start: number; end: number; target: string }[] = [];
  for (const pattern of LINK_PATTERNS)
    for (const match of text.matchAll(pattern)) {
      const end = match.index + match[0].length;
      const start = end - (match[1]?.length ?? 0);
      if (spans.some((span) => start >= span.start && end <= span.end))
        continue;
      const target = match[1]?.replace(/[.,;:!?'"*_`]+$/, '');
      if (target && !isAppRelativeLink(target))
        spans.push({ start, end, target });
    }
  return [
    ...new Set(
      spans.toSorted((a, b) => a.start - b.start).map(({ target }) => target),
    ),
  ];
}
