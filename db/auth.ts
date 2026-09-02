const SESSION_COOKIE = 'sable_session';
const SESSION_DURATION_SECONDS = 60 * 60 * 12;
const PASSWORD_MAX_LENGTH = 256;

export type AuthenticatedUser = {
  userId: string;
  distributorId: string;
  userDisplayName: string;
  email: string;
  role: 'account_admin' | 'buyer' | 'support';
  distributorDisplayName: string;
  accountTier: string;
  paymentTerms: string;
  currency: string;
  region: string;
};

type CredentialRow = {
  user_id: string;
  password_salt: string;
  password_hash: string;
  password_iterations: number;
};

type SessionRow = {
  user_id: string;
  distributor_id: string;
  user_display_name: string;
  email: string;
  role: AuthenticatedUser['role'];
  distributor_display_name: string;
  account_tier: string;
  payment_terms: string;
  currency: string;
  region: string;
};

export function parseLoginInput(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const email =
    typeof candidate.email === 'string'
      ? candidate.email.trim().toLowerCase()
      : '';
  const password =
    typeof candidate.password === 'string' ? candidate.password : '';
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    password.length < 12 ||
    password.length > PASSWORD_MAX_LENGTH
  )
    return null;
  return { email, password };
}

export function isTrustedMutation(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return false;
  const fetchSite = request.headers.get('sec-fetch-site');
  return (
    !fetchSite ||
    fetchSite === 'same-origin' ||
    fetchSite === 'same-site' ||
    fetchSite === 'none'
  );
}

export async function authenticateCredentials(
  db: D1Database,
  email: string,
  password: string,
) {
  const row = await db
    .prepare(`SELECT u.user_id, c.password_salt, c.password_hash,
      c.password_iterations
      FROM users u
      JOIN user_credentials c ON c.user_id = u.user_id
      JOIN distributors d ON d.customer_id = u.distributor_id
      WHERE lower(u.email) = ?
        AND u.status = 'active'
        AND d.account_status = 'active'`)
    .bind(email.toLowerCase())
    .first<CredentialRow>();
  if (!row) return null;

  const candidateHash = await derivePasswordHash(
    password,
    row.password_salt,
    Number(row.password_iterations),
  );
  return constantTimeEqual(candidateHash, row.password_hash)
    ? row.user_id
    : null;
}

export async function createSession(
  db: D1Database,
  userId: string,
  request: Request,
) {
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DURATION_SECONDS * 1000);
  const token = randomToken();
  const tokenHash = await hashToken(token);
  const sessionId = `SES-${crypto.randomUUID().toUpperCase()}`;
  const nowIso = now.toISOString();

  await db.batch([
    db
      .prepare(
        'DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL',
      )
      .bind(nowIso),
    db
      .prepare(`INSERT INTO sessions (
        session_id, token_hash, user_id, created_at, last_seen_at, expires_at,
        revoked_at, user_agent
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`)
      .bind(
        sessionId,
        tokenHash,
        userId,
        nowIso,
        nowIso,
        expires.toISOString(),
        request.headers.get('user-agent')?.slice(0, 240) ?? null,
      ),
    db
      .prepare('UPDATE users SET last_login_at = ? WHERE user_id = ?')
      .bind(nowIso, userId),
  ]);

  return sessionCookie(request, token, SESSION_DURATION_SECONDS);
}

export async function getAuthenticatedUser(
  db: D1Database,
  request: Request,
): Promise<AuthenticatedUser | null> {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await hashToken(token);
  const row = await db
    .prepare(`SELECT u.user_id, u.distributor_id,
      u.display_name AS user_display_name, u.email, u.role,
      d.display_name AS distributor_display_name, d.account_tier,
      d.payment_terms, d.currency, d.region
      FROM sessions s
      JOIN users u ON u.user_id = s.user_id
      JOIN distributors d ON d.customer_id = u.distributor_id
      WHERE s.token_hash = ?
        AND s.revoked_at IS NULL
        AND s.expires_at > ?
        AND u.status = 'active'
        AND d.account_status = 'active'`)
    .bind(tokenHash, new Date().toISOString())
    .first<SessionRow>();
  if (!row) return null;

  return {
    userId: row.user_id,
    distributorId: row.distributor_id,
    userDisplayName: row.user_display_name,
    email: row.email,
    role: row.role,
    distributorDisplayName: row.distributor_display_name,
    accountTier: row.account_tier,
    paymentTerms: row.payment_terms,
    currency: row.currency,
    region: row.region,
  };
}

export async function revokeSession(db: D1Database, request: Request) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return;
  await db
    .prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?')
    .bind(new Date().toISOString(), await hashToken(token))
    .run();
}

export function clearSessionCookie(request: Request) {
  return sessionCookie(request, '', 0);
}

function sessionCookie(request: Request, token: string, maxAge: number) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function getCookie(request: Request, name: string) {
  const cookies = request.headers.get('cookie') ?? '';
  for (const part of cookies.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

async function derivePasswordHash(
  password: string,
  salt: string,
  iterations: number,
) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: base64UrlToBytes(salt),
      iterations,
    },
    material,
    256,
  );
  return bytesToBase64Url(new Uint8Array(bits));
}

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function base64UrlToBytes(value: string) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
