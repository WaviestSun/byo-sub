// server.js: starts byo sub on http://127.0.0.1 and routes each request.
//
// It listens on 127.0.0.1 only, so nothing outside this computer can reach it.
// It also refuses requests that don't come from its own page, so other websites
// open in your browser can't use your ChatGPT plan through it.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { APP_NAME, startSignIn, finishSignIn, signOut } from './src/auth.js';
import { loadAccount, hasPlanUsage, SignedOutError } from './src/tokens.js';
import { listModels, streamReply } from './src/chat.js';

const PREFERRED_PORT = 1455;
let port = PREFERRED_PORT;

const PUBLIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/chatgpt-mark.svg': ['chatgpt-mark.svg', 'image/svg+xml'],
};

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function redirect(res, location) {
  res.writeHead(302, { ...SECURITY_HEADERS, location, 'cache-control': 'no-store' });
  res.end();
}

async function handle(req, res) {
  const origin = `http://127.0.0.1:${port}`;
  const url = new URL(req.url, origin);

  // Only answer requests addressed to 127.0.0.1:<port>. This blocks "DNS rebinding",
  // where a website points its own domain name at your computer.
  if (req.headers.host !== `127.0.0.1:${port}`) {
    if (req.method === 'GET') return redirect(res, origin + url.pathname + url.search); // e.g. someone typed localhost
    return send(res, 403, { error: 'wrong_host' });
  }
  // Anything that changes state must come from our own page.
  if (req.method !== 'GET' && req.headers.origin !== origin) return send(res, 403, { error: 'wrong_origin' });

  const route = `${req.method} ${url.pathname}`;

  if (req.method === 'GET' && PUBLIC_FILES[url.pathname]) {
    const [file, type] = PUBLIC_FILES[url.pathname];
    return send(res, 200, await readFile(new URL(`./public/${file}`, import.meta.url)), type);
  }

  if (route === 'GET /auth/start') {
    const askAgain = url.searchParams.has('consent');
    const retried = url.searchParams.has('retried');
    return redirect(res, await startSignIn({ port, askAgain, retried }));
  }

  if (route === 'GET /auth/callback') {
    const result = await finishSignIn(url.searchParams);
    if (result.error === 'retry') return redirect(res, '/auth/start?retried'); // the code expired: start over once
    return redirect(res, result.ok ? '/?signin=ok' : `/?error=${result.error}`);
  }

  if (route === 'GET /api/session') {
    const account = await loadAccount();
    return send(res, 200, {
      appName: APP_NAME,
      signedIn: Boolean(account?.access_token),
      email: account?.email ?? null,
      planUsage: hasPlanUsage(account),
    });
  }

  if (route === 'POST /api/signout') return send(res, 200, await signOut());

  if (route === 'GET /api/models') {
    try {
      return send(res, 200, { models: await listModels() });
    } catch (err) {
      const code = err instanceof SignedOutError ? 'signed_out' : err.code ?? 'error';
      return send(res, code === 'signed_out' ? 401 : 502, { error: code });
    }
  }

  if (route === 'POST /api/chat') {
    const body = await readJsonBody(req);
    const ok = body && typeof body.model === 'string' && body.model.length < 200 &&
      Array.isArray(body.messages) && body.messages.length > 0 && body.messages.length <= 200 &&
      body.messages.every((m) => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string');
    if (!ok) return send(res, 400, { error: 'bad_request' });

    // Stream newline-separated JSON events to the page as they arrive.
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    const stop = new AbortController();
    res.on('close', () => stop.abort()); // the page went away: stop asking OpenAI
    await streamReply(body, (event) => res.write(JSON.stringify(event) + '\n'), stop.signal);
    return res.end();
  }

  send(res, 404, { error: 'not_found' });
}

// Reads a JSON request body (up to 1 MB). Returns null if it's too big or not JSON.
async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) return null;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(`Error on ${req.method} ${req.url.split('?')[0]}: ${err.message}`); // never log query strings: they can hold codes
    if (!res.headersSent) send(res, 500, { error: 'server_error' });
  });
});

// Try port 1455; if something else is using it, let the OS pick a free one.
server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE' || port !== PREFERRED_PORT) throw err;
  port = 0;
  server.listen(0, '127.0.0.1');
});
server.on('listening', () => {
  port = server.address().port;
  console.log(`\n  ${APP_NAME} is running at http://127.0.0.1:${port}\n`);
});
server.listen(PREFERRED_PORT, '127.0.0.1');
