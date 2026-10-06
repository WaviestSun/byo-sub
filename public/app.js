// app.js: the page's brain. Picks the screen, plays the "plan drops into your
// wallet" moment, sends your messages and types out the replies.
// The browser never sees a token: it only talks to the local server.

import { runBoot, primeAudio, clink, trail, wait, calm } from './effects.js';

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const start = $('start');
const USAGE_URL = 'https://chatgpt.com/settings/usage';
const DOCS_URL = 'https://developers.openai.com/siwc/token-sharing-open-source';

// Little helpers for remembering your theme and model (only in this browser).
const remember = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
const recall = (key) => { try { return localStorage.getItem(key); } catch { return null; } };

// Messages for the sign-in screen: [title, text].
const NOTICES = {
  declined: ['Plan usage is off', "You signed in but didn't let byo sub use your ChatGPT plan. Chat needs that permission, and you can turn it on now."],
  plan_off: ['Plan usage is off', "byo sub doesn't have permission to use your ChatGPT plan yet. Continue with ChatGPT to allow it."],
  expired: ['Sign-in timed out', 'That sign-in link expired or was already used. Please try again.'],
  mismatch: ['Different account', "That's a different ChatGPT account from the one saved here. Sign out first to switch."],
  oauth: ["Sign-in didn't finish", 'Something went wrong on the way back from ChatGPT. Please try again.'],
  signed_out: ['Signed out', 'Your ChatGPT connection ended. Sign in again to keep chatting.'],
  bye: ['Signed out', 'Your tokens were deleted from this computer.'],
  bye_unconfirmed: ['Signed out here', "Your tokens were deleted, but OpenAI didn't confirm the session ended. You can disconnect byo sub in ChatGPT settings."],
};

// Cards for when a reply fails. `brand` shows the ChatGPT name, as OpenAI asks for usage-limit messages.
const CHAT_ERRORS = {
  limit: { brand: true, title: 'Usage limit reached', text: "You've hit a limit on your ChatGPT plan or on byo sub. Review it in ChatGPT settings.", link: ['Manage usage ↗', USAGE_URL], primary: true },
  not_eligible: { title: "Your plan can't be used here", text: 'Using your plan in byo sub needs ChatGPT Plus or Pro on this account.', link: ['How it works ↗', DOCS_URL] },
  unavailable: { title: 'ChatGPT is busy', text: "Your usage couldn't be checked just now. Try again in a minute." },
  auth: { title: 'Sign-in not accepted', text: "ChatGPT didn't accept this sign-in. Try signing out and back in." },
  incomplete: { title: 'Reply cut short', text: 'The reply stopped before it finished.' },
  interrupted: { title: 'Connection dropped', text: 'The reply stopped before it finished. Try again.' },
  error: { title: 'Something went wrong', text: "That message didn't go through." },
};

const conversation = []; // the whole chat, sent with every message
let tokensThisChat = 0;  // added up from each reply's usage report
let model = null;        // the model slug you picked
let streaming = null;    // lets the stop button cancel the reply in progress

// ---------- Theme ----------

function setTheme(theme) {
  root.dataset.theme = theme;
  $('theme').setAttribute('aria-label', theme === 'night' ? 'Switch to day mode' : 'Switch to night mode');
  remember('theme', theme);
}
setTheme(recall('theme') === 'night' ? 'night' : 'day'); // day unless you picked night
$('theme').addEventListener('click', () => setTheme(root.dataset.theme === 'night' ? 'day' : 'night'));

// Browsers only allow sound after a tap, so the first tap anywhere switches it on.
document.addEventListener('pointerdown', primeAudio);

// ---------- Pop-up menus (account and model) ----------

const closers = [];
function closeMenus() { closers.forEach((close) => close()); }
function popupMenu(button, panel) {
  const close = () => { panel.hidden = true; button.setAttribute('aria-expanded', 'false'); };
  closers.push(close);
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = panel.hidden;
    closeMenus();
    if (!opening) return;
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    (panel.querySelector('[aria-selected="true"]') ?? panel.querySelector('a, button'))?.focus();
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); button.focus(); }
  });
}
document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenus(); });
popupMenu($('account-button'), $('account-menu'));
popupMenu($('model-button'), $('model-menu'));

// ---------- Screens ----------

const getSession = () => fetch('/api/session').then((r) => r.json());

function setHeader(session) {
  $('account').hidden = !session.signedIn;
  document.querySelector('.host').hidden = session.signedIn;
  $('email').textContent = session.email ?? '';
  $('avatar-letter').textContent = (session.email ?? '?')[0].toUpperCase();
  root.toggleAttribute('data-plan', Boolean(session.planUsage));
}

function showStart(session, notice) {
  setHeader(session);
  $('chat').hidden = true;
  start.hidden = false;
  start.className = 'screen start';
  const [title, text] = NOTICES[notice] ?? [];
  $('notice').hidden = !title;
  $('notice-title').textContent = title ?? '';
  $('notice-text').textContent = text ?? '';
  // After a decline, ask OpenAI to show the plan permission screen again.
  $('continue').dataset.href = notice === 'declined' || notice === 'plan_off' ? '/auth/start?consent' : '/auth/start';
}

async function showChat(session, { arrive = false } = {}) {
  setHeader(session);
  start.hidden = true;
  $('chat').hidden = false;
  document.querySelector('.plan-chip').classList.toggle('arrive', arrive);
  $('input').focus();
  await loadModels();
}

// "Continue with ChatGPT": the coin pops out of the button, then this tab goes to OpenAI.
$('continue').addEventListener('click', async () => {
  const href = $('continue').dataset.href;
  if (!calm()) {
    const button = $('continue').getBoundingClientRect();
    const coin = $('coin').getBoundingClientRect();
    start.style.setProperty('--from-y', `${button.top + button.height / 2 - (coin.top + coin.height / 2)}px`);
    start.classList.add('popping');
    await wait(620);
  }
  location.href = href;
});

// If you press Back on OpenAI's page, the browser may restore this page mid-animation.
addEventListener('pageshow', (e) => { if (e.persisted) start.classList.remove('popping'); });

// Back from OpenAI with plan permission: drop the coin into the wallet.
async function playConnect(session) {
  showStart(session);
  if (calm()) {
    start.classList.add('connected');
  } else {
    start.classList.add('returning', 'hovering');
    // Tap the coin (which also allows the sound), or it drops by itself after 4 seconds.
    await Promise.race([new Promise((r) => $('coin').addEventListener('click', r, { once: true })), wait(4000)]);
    start.classList.replace('hovering', 'dropping');
    await wait(400); // the coin reaches the bottom of the pocket
    start.classList.add('snapped');
    clink();
    await wait(600);
    start.classList.add('connected');
  }
  await wait(1000);
  if (!session.welcomed) await showWelcome();
  else await wait(600);
  showChat(session, { arrive: true });
}

// The one-time "You're using your ChatGPT plan" card.
function showWelcome() {
  $('welcome').hidden = false;
  $('got-it').focus();
  return new Promise((resolve) => {
    $('got-it').addEventListener('click', async () => {
      fetch('/api/welcomed', { method: 'POST' });
      $('welcome').classList.add('leaving');
      await wait(250);
      $('welcome').hidden = true;
      $('welcome').classList.remove('leaving');
      resolve();
    }, { once: true });
  });
}

function clearChat() {
  streaming?.abort();
  conversation.length = 0;
  tokensThisChat = 0;
  $('messages').replaceChildren();
  $('chat').classList.add('empty');
  $('usage').hidden = true;
}

async function signedOut() {
  clearChat();
  showStart(await getSession(), 'signed_out');
}

$('signout').addEventListener('click', async () => {
  closeMenus();
  const { revoked } = await fetch('/api/signout', { method: 'POST' }).then((r) => r.json());
  clearChat();
  showStart(await getSession(), revoked ? 'bye' : 'bye_unconfirmed');
});

// ---------- Chat ----------

async function loadModels() {
  const res = await fetch('/api/models');
  const body = await res.json();
  if (body.error === 'signed_out') return signedOut();
  if (!res.ok) return;
  // Use the model you picked last time if it's still offered, otherwise the first one (OpenAI's default order).
  const saved = body.models.find((m) => m.slug === recall('model')) ?? body.models[0];
  $('model-menu').replaceChildren(...body.models.map((m) => {
    const li = document.createElement('li');
    const option = document.createElement('button');
    option.type = 'button';
    option.setAttribute('role', 'option');
    option.dataset.slug = m.slug;
    option.innerHTML = '<span></span><svg class="check" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>';
    option.firstChild.textContent = m.name;
    option.addEventListener('click', () => { pickModel(m); closeMenus(); $('input').focus(); });
    li.append(option);
    return li;
  }));
  if (saved) pickModel(saved);
}

function pickModel(m) {
  model = m.slug;
  remember('model', m.slug);
  $('model-name').textContent = m.name;
  $('model-menu').querySelectorAll('[role="option"]').forEach((o) => o.setAttribute('aria-selected', String(o.dataset.slug === m.slug)));
}

const scrollDown = () => { $('messages').scrollTop = $('messages').scrollHeight; };

function addUserMessage(text) {
  const li = Object.assign(document.createElement('li'), { className: 'msg user fresh', textContent: text });
  $('messages').append(li);
  trail(li);
  scrollDown();
}

// The reply bubble. Words arrive in bursts, so this reveals them at a steady pace, like typing.
function addReply() {
  const li = document.createElement('li');
  li.className = 'msg assistant streaming';
  li.innerHTML = '<div class="text"><span class="cursor"></span></div>';
  $('messages').append(li);
  scrollDown();

  const typed = document.createTextNode('');
  li.querySelector('.text').prepend(typed);
  let target = '';
  let frame = requestAnimationFrame(function tick() {
    const behind = target.length - typed.data.length;
    if (behind > 0) {
      typed.data = target.slice(0, typed.data.length + Math.ceil(behind / 12));
      scrollDown();
    }
    frame = requestAnimationFrame(tick);
  });

  return {
    li,
    add(text) {
      target += text;
      if (calm() || document.hidden) typed.data = target;
    },
    async finish() {
      while (typed.data.length < target.length && !document.hidden) await wait(30);
      typed.data = target;
      cancelAnimationFrame(frame);
      li.querySelector('.cursor').remove();
      li.classList.remove('streaming');
    },
  };
}

function addErrorCard(li, code, detail) {
  const info = CHAT_ERRORS[code] ?? CHAT_ERRORS.error;
  const card = document.createElement('div');
  card.className = 'chat-error';
  if (info.brand) {
    card.innerHTML = '<div class="brand"><img class="on-night" src="/chatgpt-mark-white.svg" alt=""><img class="on-day" src="/chatgpt-mark.svg" alt="">ChatGPT</div>';
  }
  card.append(Object.assign(document.createElement('h3'), { textContent: info.title }));
  card.append(Object.assign(document.createElement('p'), { textContent: info.text + (code === 'error' && detail ? ` (${detail})` : '') }));
  if (info.link) {
    const [text, href] = info.link;
    card.append(Object.assign(document.createElement('a'), { textContent: text, href, target: '_blank', rel: 'noopener', className: info.primary ? 'button-link' : '' }));
  }
  li.append(card);
  scrollDown();
}

async function sendMessage(text) {
  conversation.push({ role: 'user', content: text });
  $('chat').classList.remove('empty');
  addUserMessage(text);
  const reply = addReply();
  streaming = new AbortController();
  setSendButton();

  let replyText = '';
  let failed = null;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: conversation }),
      signal: streaming.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // The server sends one JSON event per line as the reply streams in.
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const event = JSON.parse(line);
        if (event.type === 'delta') {
          replyText += event.text;
          reply.add(event.text);
        } else if (event.type === 'done') {
          conversation.push({ role: 'assistant', content: replyText });
          tokensThisChat += event.usage?.total ?? 0;
          $('usage').hidden = false;
          $('usage').textContent = `${tokensThisChat.toLocaleString()} tokens this chat ·`;
        } else if (event.type === 'error') {
          failed = event;
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      // You pressed stop: keep what arrived so far as part of the conversation.
      if (replyText) conversation.push({ role: 'assistant', content: replyText });
      else reply.li.remove();
    } else {
      failed = { code: 'error', detail: err.message };
    }
  }

  await reply.finish();
  streaming = null;
  setSendButton();
  if (failed?.code === 'signed_out') return signedOut();
  if (failed) addErrorCard(reply.li, failed.code, failed.detail);
}

// The round button sends, or stops the reply while one is streaming.
function setSendButton() {
  $('send').classList.toggle('stop', Boolean(streaming));
  $('send').setAttribute('aria-label', streaming ? 'Stop' : 'Send');
  $('send').disabled = !streaming && !$('input').value.trim();
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  if (streaming) return streaming.abort();
  const text = $('input').value.trim();
  if (!text || !model) return;
  $('input').value = '';
  $('input').style.height = '';
  sendMessage(text);
});

// Enter sends, Shift+Enter adds a new line. The box grows as you type.
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!streaming) $('composer').requestSubmit();
  }
});
$('input').addEventListener('input', () => {
  setSendButton();
  $('input').style.height = 'auto';
  $('input').style.height = `${$('input').scrollHeight}px`;
});

// ---------- Start ----------

const params = new URLSearchParams(location.search);
history.replaceState(null, '', '/');
const backFromOpenAI = params.has('signin') || params.has('error');
let booted = false;
try { booted = sessionStorage.getItem('booted') === '1'; sessionStorage.setItem('booted', '1'); } catch {}

const [session] = await Promise.all([getSession(), backFromOpenAI || booted ? $('boot').remove() : runBoot()]);

if (session.planUsage && params.get('signin') === 'ok') playConnect(session);
else if (session.planUsage) showChat(session);
else showStart(session, params.get('error') ?? (session.signedIn ? 'plan_off' : null));
