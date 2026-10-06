// auth.js: "Continue with ChatGPT", start to finish.
//
// The flow, top to bottom:
//   1. startSignIn()    builds the OpenAI sign-in link and remembers this attempt
//   2. (you approve on chatgpt.com, which sends your browser back to /auth/callback)
//   3. finishSignIn()   checks the reply, swaps the one-time code for tokens,
//                       verifies the ID token, and saves everything locally
//   4. signOut()        tells OpenAI to end the session, then deletes the tokens
//
// Docs: https://developers.openai.com/siwc/token-sharing-open-source/sign-in

import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { getHostId, loadAccount, saveAccount, clearTokens, ISSUER, TOKEN_URL, RESOURCE } from './tokens.js';

export const APP_NAME = 'byo sub'; // shown to you on OpenAI's approval screen

const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const REVOKE_URL = `${ISSUER}/api/accounts/oauth/revoke`;
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`)); // OpenAI's public signing keys
// Who you are (openid profile email), a refresh token (offline_access),
// and permission to use your ChatGPT plan for API requests (the last two).
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';

// Sign-in attempts in progress, keyed by their random `state`. Each one expires after 10 minutes.
const attempts = new Map();
const random = (bytes = 32) => randomBytes(bytes).toString('base64url');

// Step 1: build the URL that sends you to OpenAI.
export async function startSignIn({ port, askAgain = false, retried = false }) {
  const account = await loadAccount();
  const clientId = account?.client_id; // set after your first sign-in
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`; // must be 127.0.0.1, never localhost

  // PKCE: we keep a secret `verifier` and send only its SHA-256 hash. Later we prove
  // we're the same app by sending the verifier itself when we swap the code for tokens.
  const verifier = random(64);
  const state = random(); // ties OpenAI's reply to this exact attempt
  const nonce = random(); // OpenAI copies this into the ID token so we can check it's fresh

  attempts.set(state, { verifier, nonce, redirectUri, clientId, retried, expiresAt: Date.now() + 10 * 60_000 });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId ?? 'dynamic_agent_client', // first time: ask OpenAI to register this app for you
    redirect_uri: redirectUri,
    scope: SCOPES,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    ext_agent_host_id: await getHostId(),
  });
  if (!clientId) {
    params.set('agent_name_hint', APP_NAME); // only on first registration
  } else {
    // Returning: hint which account so OpenAI can skip the account picker.
    if (account.id_token) params.set('id_token_hint', account.id_token);
    if (account.email) params.set('login_hint', account.email);
    if (askAgain) params.set('prompt', 'consent'); // show the plan permission screen again
  }
  return `${AUTHORIZE_URL}?${params}`;
}

// Step 3: OpenAI sent your browser back here. Returns { ok: true } or { error: '<reason>' }.
export async function finishSignIn(query) {
  // Check `state` before anything else: is this a reply to an attempt we started?
  const attempt = attempts.get(query.get('state'));
  attempts.delete(query.get('state'));
  if (!attempt || attempt.expiresAt < Date.now()) return { error: 'expired' };

  if (query.get('error') === 'access_denied') return { error: 'declined' };
  if (query.get('error')) return { error: 'oauth' };
  const code = query.get('code');
  if (!code) return { error: 'oauth' };

  // Work out the client ID. First registration: OpenAI hands us a new one (oaiapp_...).
  // Returning: it may be omitted, but if it's present it must match the one we saved.
  const returnedId = query.get('client_id');
  let clientId = attempt.clientId;
  if (clientId) {
    if (returnedId && returnedId !== clientId) return { error: 'mismatch' };
  } else {
    if (!returnedId || returnedId === 'dynamic_agent_client') return { error: 'oauth' };
    clientId = returnedId;
    // Save it right away, so a retry reuses this registration instead of making another.
    await saveAccount({ ...(await loadAccount()), client_id: clientId });
  }

  // Swap the one-time code for tokens. No client secret: the PKCE verifier proves it's us.
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: attempt.verifier,
      redirect_uri: attempt.redirectUri,
      resource: RESOURCE,
    }),
  });
  const tokens = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Token exchange failed: HTTP ${res.status} ${tokens.error ?? ''} (request ${res.headers.get('x-request-id') ?? 'n/a'})`);
    if (tokens.error === 'invalid_grant') return { error: attempt.retried ? 'expired' : 'retry' };
    return { error: 'oauth' };
  }

  // Verify the ID token: signed by OpenAI, issued to this app, not expired, and carrying our nonce.
  let identity;
  try {
    ({ payload: identity } = await jwtVerify(tokens.id_token, JWKS, {
      issuer: ISSUER,
      audience: clientId,
      requiredClaims: ['sub', 'exp', 'iat'],
      clockTolerance: 5,
    }));
    if (identity.nonce !== attempt.nonce) throw new Error('nonce mismatch');
  } catch (err) {
    console.error(`ID token rejected: ${err.code ?? err.message}`);
    return { error: 'oauth' };
  }

  // A returning sign-in must be the same person as before.
  const saved = await loadAccount();
  if (saved?.subject && saved.subject !== identity.sub) return { error: 'mismatch' };

  // Signing in proves who you are. Using your plan is a separate permission you can decline,
  // so read what OpenAI actually granted.
  const scopes = (tokens.scope ?? query.get('scope') ?? '').split(/\s+/).filter(Boolean);
  await saveAccount({
    client_id: clientId,
    issuer: ISSUER,
    subject: identity.sub,
    email: identity.email ?? saved?.email ?? null,
    id_token: tokens.id_token, // kept so the next sign-in can send it as id_token_hint
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type,
    expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    earliest_refresh_at: tokens.earliest_refresh_at ?? null,
    scopes,
    saved_at: new Date().toISOString(),
    welcomed: saved?.welcomed ?? false,
  });
  return { ok: true, planUsage: scopes.includes(PLAN_SCOPE) };
}

// Step 4: end the session at OpenAI, then delete the tokens here.
// Returns { revoked } so the UI can say if OpenAI didn't confirm.
export async function signOut() {
  const account = await loadAccount();
  let revoked = !account?.refresh_token;
  for (let attempt = 0; attempt < 3 && !revoked; attempt++) {
    try {
      const res = await fetch(REVOKE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: account.refresh_token, token_type_hint: 'refresh_token', client_id: account.client_id }),
      });
      if (res.ok) revoked = true;
      else if (res.status < 500) break; // a 4xx won't get better with retries
    } catch {
      // network hiccup: try again
    }
    if (!revoked) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  await clearTokens();
  return { revoked };
}
