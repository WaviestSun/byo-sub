// app.js: the page's brain. Shows the right screen, sends your messages,
// and prints the reply as it streams in.
// The browser never sees a token: it only talks to the local server.

const $ = (id) => document.getElementById(id);
const USAGE_URL = 'https://chatgpt.com/settings/usage';
const DOCS_URL = 'https://developers.openai.com/siwc/token-sharing-open-source';

const SIGN_IN_MESSAGES = {
  declined: "You signed in but didn't let byo sub use your ChatGPT plan. Chat needs that permission. Press Continue with ChatGPT to allow it.",
  expired: 'That sign-in timed out or was already used. Please try again.',
  mismatch: "That's a different ChatGPT account from the one saved here. Sign out first to switch accounts.",
  oauth: "Sign-in didn't finish. Please try again.",
  signed_out: 'Your ChatGPT connection ended. Sign in again to keep chatting.',
};

// What to say when a reply fails. Some include a link: [text, linkText, url].
const CHAT_ERRORS = {
  limit: ["You've reached a usage limit on your ChatGPT plan or on byo sub.", 'Manage usage', USAGE_URL],
  not_eligible: ['Using your plan here needs ChatGPT Plus or Pro on this account.', 'How it works', DOCS_URL],
  unavailable: ["ChatGPT couldn't check your usage just now. Try again in a minute."],
  auth: ["ChatGPT didn't accept this sign-in. Try signing out and back in."],
  incomplete: ['The reply stopped early.'],
  interrupted: ['The connection dropped before the reply finished. Try again.'],
  error: ['Something went wrong.'],
};

const conversation = []; // the whole conversation, sent with every message

function showMessage(text) {
  $('message').textContent = text ?? '';
  $('message').hidden = !text;
}

async function render() {
  const session = await fetch('/api/session').then((r) => r.json());
  $('signed-out').hidden = session.signedIn;
  $('signed-in').hidden = !session.signedIn;
  $('email').textContent = session.email ?? 'unknown';
  $('no-plan').hidden = session.planUsage;
  $('chat').hidden = !session.planUsage;
  if (session.planUsage) await loadModels();
}

async function loadModels() {
  const res = await fetch('/api/models');
  const body = await res.json();
  if (body.error === 'signed_out') return signedOut();
  if (!res.ok) return showMessage("Couldn't load your models. Reload the page to try again.");
  $('model').replaceChildren(...body.models.map((m) => new Option(m.name, m.slug)));
}

function signedOut() {
  showMessage(SIGN_IN_MESSAGES.signed_out);
  render();
}

function addBubble(role, text = '') {
  const li = document.createElement('li');
  li.className = role;
  li.textContent = text;
  $('messages').append(li);
  li.scrollIntoView({ block: 'end' });
  return li;
}

function showChatError(li, code, detail) {
  const [text, linkText, url] = CHAT_ERRORS[code] ?? CHAT_ERRORS.error;
  const note = document.createElement('p');
  note.className = 'error';
  note.textContent = text + (code === 'error' && detail ? ` (${detail})` : '') + ' ';
  if (url) {
    const a = Object.assign(document.createElement('a'), { href: url, target: '_blank', rel: 'noopener', textContent: linkText });
    note.append(a);
  }
  li.append(note);
}

async function sendMessage(text) {
  conversation.push({ role: 'user', content: text });
  addBubble('user', text);
  const reply = addBubble('assistant');
  $('send').disabled = true;

  let replyText = '';
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: $('model').value, messages: conversation }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Read newline-separated JSON events as they arrive.
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
          reply.textContent = replyText;
          reply.scrollIntoView({ block: 'end' });
        } else if (event.type === 'done') {
          conversation.push({ role: 'assistant', content: replyText });
        } else if (event.type === 'error') {
          if (event.code === 'signed_out') return signedOut();
          showChatError(reply, event.code, event.detail);
        }
      }
    }
  } catch (err) {
    showChatError(reply, 'error', err.message);
  } finally {
    $('send').disabled = false;
  }
}

// Show what happened on the way back from OpenAI, then tidy the address bar.
const params = new URLSearchParams(location.search);
const error = params.get('error');
if (error) {
  showMessage(SIGN_IN_MESSAGES[error] ?? SIGN_IN_MESSAGES.oauth);
  // After a decline, the retry button asks for the plan permission screen again.
  if (error === 'declined') document.querySelector('#signed-out .siwc').dataset.href = '/auth/start?consent';
}
history.replaceState(null, '', '/');

// "Continue with ChatGPT" just sends this tab to the server, which redirects to OpenAI.
document.querySelectorAll('.siwc').forEach((b) => b.addEventListener('click', () => { location.href = b.dataset.href; }));

$('signout').addEventListener('click', async () => {
  const { revoked } = await fetch('/api/signout', { method: 'POST' }).then((r) => r.json());
  conversation.length = 0;
  $('messages').replaceChildren();
  showMessage(revoked
    ? 'Signed out. Your tokens were deleted from this computer.'
    : "Signed out here, but OpenAI didn't confirm the session ended. You can disconnect byo sub in ChatGPT settings.");
  render();
});

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('input').value.trim();
  if (!text || $('send').disabled) return;
  $('input').value = '';
  sendMessage(text);
});

// Enter sends, Shift+Enter adds a new line.
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});

render();
