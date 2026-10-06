// app.js: shows whether you're signed in, and handles the buttons.
// The browser never sees a token: it only asks the local server yes/no questions.

const $ = (id) => document.getElementById(id);

const MESSAGES = {
  declined: "You signed in but didn't let byo sub use your ChatGPT plan. Chat needs that permission. Press Continue with ChatGPT to allow it.",
  expired: 'That sign-in timed out or was already used. Please try again.',
  mismatch: "That's a different ChatGPT account from the one saved here. Sign out first to switch accounts.",
  oauth: "Sign-in didn't finish. Please try again.",
};

function showMessage(text) {
  $('message').textContent = text;
  $('message').hidden = !text;
}

async function render() {
  const session = await fetch('/api/session').then((r) => r.json());
  $('signed-out').hidden = session.signedIn;
  $('signed-in').hidden = !session.signedIn;
  $('email').textContent = session.email ?? 'unknown';
  $('plan').textContent = session.planUsage ? 'yes' : 'no';
  $('allow').hidden = session.planUsage; // signed in without plan permission: offer to ask again
}

// Show what happened on the way back from OpenAI, then tidy the address bar.
const params = new URLSearchParams(location.search);
const error = params.get('error');
if (error) {
  showMessage(MESSAGES[error] ?? MESSAGES.oauth);
  // After a decline, the retry button asks for the plan permission screen again.
  if (error === 'declined') document.querySelector('#signed-out .siwc').dataset.href = '/auth/start?consent';
}
history.replaceState(null, '', '/');

// "Continue with ChatGPT" just sends this tab to the server, which redirects to OpenAI.
document.querySelectorAll('.siwc').forEach((b) => b.addEventListener('click', () => { location.href = b.dataset.href; }));

$('signout').addEventListener('click', async () => {
  const { revoked } = await fetch('/api/signout', { method: 'POST' }).then((r) => r.json());
  showMessage(revoked
    ? 'Signed out. Your tokens were deleted from this computer.'
    : "Signed out here, but OpenAI didn't confirm the session ended. You can disconnect byo sub in ChatGPT settings.");
  render();
});

render();
