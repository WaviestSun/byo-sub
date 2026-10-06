// server.js: starts byo sub on http://127.0.0.1 and routes each request.
//
// It listens on 127.0.0.1 only, so nothing outside this computer can reach it.
// It also refuses requests that don't come from its own page, so other websites
// open in your browser can't use your ChatGPT plan through it.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_NAME, startSignIn, finishSignIn, signOut } from './src/auth.js';
import { loadAccount, saveAccount, hasPlanUsage, SignedOutError } from './src/tokens.js';
import { listModels, streamReply } from './src/chat.js';
import { listChats, getChat, saveChat, deleteChat } from './src/chats.js';

const PREFERRED_PORT = 1455;
let port = PREFERRED_PORT;

// Files in public/ are served as-is. Only these types, and nothing outside that folder.
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

async function servePublic(res, pathname) {
  const file = normalize(join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  const type = TYPES[extname(file)];
  if (!type || !file.startsWith(PUBLIC_DIR) || file.includes(`${sep}.`)) return false;
  try {
    send(res, 200, await readFile(file), type);
    return true;
  } catch {
    return false;
  }
}

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

  if (req.method === 'GET' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/auth/')) {
    if (await servePublic(res, decodeURIComponent(url.pathname))) return;
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
      welcomed: Boolean(account?.welcomed),
    });
  }

  if (route === 'POST /api/signout') return send(res, 200, await signOut());

  // The "You're using your ChatGPT plan" card only shows once, so remember it was seen.
  if (route === 'POST /api/welcomed') {
    const account = await loadAccount();
    if (account) await saveAccount({ ...account, welcomed: true });
    return send(res, 200, { ok: true });
  }

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

  // Saved chats: list them, open one, save one, delete one.
  if (route === 'GET /api/chats') return send(res, 200, { chats: await listChats() });
  const chatId = url.pathname.match(/^\/api\/chats\/([^/]+)$/)?.[1];
  if (chatId && req.method === 'GET') {
    const chat = await getChat(chatId);
    return chat ? send(res, 200, chat) : send(res, 404, { error: 'not_found' });
  }
  if (chatId && req.method === 'PUT') {
    const saved = await saveChat(chatId, (await readJsonBody(req, 5_000_000)) ?? {});
    return send(res, saved ? 200 : 400, { ok: saved });
  }
  if (chatId && req.method === 'DELETE') return send(res, 200, { ok: await deleteChat(chatId) });

  send(res, 404, { error: 'not_found' });
}

// Reads a JSON request body (1 MB unless told otherwise). Returns null if it's too big or not JSON.
async function readJsonBody(req, limit = 1_000_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return null;
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
