// tokens.js: reads and writes byo sub's two local files in ~/.config/byo-sub/.
//
//   host.json     a random ID for this install of the app (not secret, not about you)
//   account.json  your ChatGPT sign-in: issued client ID, email, and tokens
//
// Both are written atomically (write a temp file, then rename) with 0600 permissions,
// so only your user account can read them. Nothing in here ever logs a token.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONFIG_DIR = join(homedir(), '.config', 'byo-sub');
const HOST_FILE = join(CONFIG_DIR, 'host.json');
const ACCOUNT_FILE = join(CONFIG_DIR, 'account.json');

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeJsonAtomic(file, data) {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
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
