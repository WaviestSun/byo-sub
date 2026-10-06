// tokens.js: reads and writes byo sub's two local files in ~/.config/byo-sub/,
// and swaps an expiring access token for a fresh one.
//
//   host.json     a random ID for this install of the app (not secret, not about you)
//   account.json  your ChatGPT sign-in: issued client ID, email, and tokens
//
// Both are written atomically (write a temp file, then rename) with 0600 permissions,
// so only your user account can read them. Nothing in here ever logs a token.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const ISSUER = 'https://auth.openai.com';
export const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
export const RESOURCE = 'https://api.openai.com/v1';

export const CONFIG_DIR = join(homedir(), '.config', 'byo-sub');
const HOST_FILE = join(CONFIG_DIR, 'host.json');
const ACCOUNT_FILE = join(CONFIG_DIR, 'account.json');

export async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeJsonAtomic(file, data) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600); // in case a umask loosened it
  await rename(tmp, file);
}

// The host ID identifies this install. OpenAI asks apps to create it once,
// before the first sign-in, and reuse it forever. A random UUID says nothing about you.
export async function getHostId() {
  const saved = await readJson(HOST_FILE);
  if (saved?.ext_agent_host_id) return saved.ext_agent_host_id;
  const hostId = `urn:uuid:${randomUUID()}`;
  await writeJsonAtomic(HOST_FILE, { ext_agent_host_id: hostId });
  return hostId;
}

export const loadAccount = () => readJson(ACCOUNT_FILE);
export const saveAccount = (account) => writeJsonAtomic(ACCOUNT_FILE, account);

// Sign out keeps the issued client ID and email so the next sign-in reuses the
// same registration, but throws away every token.
export async function clearTokens() {
  const account = await loadAccount();
  if (!account) return;
  const { client_id, issuer, subject, email, welcomed } = account;
  await saveAccount({ client_id, issuer, subject, email, welcomed });
}

export const hasPlanUsage = (account) => Boolean(account?.access_token && account.scopes?.includes('chatgpt.tokens.use.direct'));

// Thrown when the sign-in is gone for good (revoked, or the refresh token expired).
// The UI responds by showing "Continue with ChatGPT" again.
export class SignedOutError extends Error {
  code = 'signed_out';
}

// Refresh tokens can only be used once, so two refreshes at the same moment would
// break each other. `refreshing` makes everyone wait for the one already in flight.
let refreshing = null;

// Returns a working access token, refreshing it first if it's near the end of its hour.
// Pass { force: true } after an API call was rejected with 401.
export async function getAccessToken({ force = false } = {}) {
  const account = await loadAccount();
  if (!hasPlanUsage(account)) throw new SignedOutError('Not signed in with plan usage');

  const now = Date.now();
  // OpenAI says when refreshing is allowed (earliest_refresh_at, in seconds). Without it, refresh 5 minutes early.
  const refreshFrom = account.earliest_refresh_at ? account.earliest_refresh_at * 1000 : account.expires_at - 5 * 60_000;
  const due = now >= refreshFrom || account.expires_at - now < 60_000;
  // `force` (after a 401) still waits for the refresh window: refreshing too early could be refused.
  if (!due) return force ? null : account.access_token;

  refreshing ??= refresh(account).finally(() => { refreshing = null; });
  try {
    return await refreshing;
  } catch (err) {
    // A network blip or OpenAI outage isn't a sign-out: keep using the old token while it lasts.
    if (!(err instanceof SignedOutError) && !force && account.expires_at > Date.now()) return account.access_token;
    throw err;
  }
}

// Codes that mean the refresh token is dead and you need to sign in again.
const DEAD_REFRESH = ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'];

async function refresh(account) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: account.client_id, // the issued oaiapp_... ID, never dynamic_agent_client
      refresh_token: account.refresh_token,
      resource: RESOURCE,
      // no `scope`: keep exactly what you granted
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Token refresh failed: HTTP ${res.status} ${body.error ?? ''} (request ${res.headers.get('x-request-id') ?? 'n/a'})`);
    if (DEAD_REFRESH.includes(body.error)) {
      await clearTokens();
      throw new SignedOutError('Refresh token no longer valid');
    }
    throw new Error(`Token refresh failed (${res.status})`);
  }

  // The refresh token rotates: save the new access token, refresh token, expiry and scopes together.
  await saveAccount({
    ...account,
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? account.refresh_token,
    id_token: body.id_token ?? account.id_token,
    expires_at: Date.now() + (body.expires_in ?? 3600) * 1000,
    earliest_refresh_at: body.earliest_refresh_at ?? null,
    scopes: body.scope ? body.scope.split(/\s+/).filter(Boolean) : account.scopes,
    saved_at: new Date().toISOString(),
  });
  return body.access_token;
}
