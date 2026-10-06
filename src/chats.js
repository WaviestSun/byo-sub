// chats.js: saves your conversations on this computer, one file per chat, in
// ~/.config/byo-sub/chats/. Reopening a chat sends its whole history again, so the
// agent picks up where you left off. Like your sign-in, only your user can read them.

import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR, readJson, writeJsonAtomic } from './tokens.js';

const CHATS_DIR = join(CONFIG_DIR, 'chats');
const VALID_ID = /^[a-z0-9-]{8,64}$/; // chat IDs become file names, so keep them boring
const fileFor = (id) => (VALID_ID.test(id) ? join(CHATS_DIR, `${id}.json`) : null);

// Newest first, with just enough to show in the sidebar.
export async function listChats() {
  let names = [];
  try {
    names = (await readdir(CHATS_DIR)).filter((n) => n.endsWith('.json'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const chats = await Promise.all(names.map((n) => readJson(join(CHATS_DIR, n)).catch(() => null)));
  return chats
    .filter((chat) => typeof chat?.id === 'string' && typeof chat.updatedAt === 'string') // skip anything unreadable
    .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export const getChat = (id) => (fileFor(id) ? readJson(fileFor(id)) : null);

// Returns false if the chat doesn't look right, so nothing odd gets written to disk.
export async function saveChat(id, { title, messages, tokens }) {
  const ok = fileFor(id) && typeof title === 'string' && Array.isArray(messages) &&
    messages.every((m) => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string');
  if (!ok) return false;
  await writeJsonAtomic(fileFor(id), {
    id,
    title: title.slice(0, 120),
    messages: messages.map(({ role, content, tokens: t }) => ({ role, content, ...(t ? { tokens: t } : {}) })),
    tokens: Number(tokens) || 0,
    updatedAt: new Date().toISOString(),
  });
  return true;
}

export async function deleteChat(id) {
  if (!fileFor(id)) return false;
  await unlink(fileFor(id)).catch((err) => { if (err.code !== 'ENOENT') throw err; });
  return true;
}
