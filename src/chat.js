// chat.js: talks to OpenAI's Responses API with your access token and streams
// the reply back to the page, a few words at a time.
//
// Rules for using a ChatGPT plan this way (from OpenAI's preview limitations):
//   - always `store: false` and `stream: true`
//   - send the whole conversation in `input` every time (no previous_response_id)
//   - the system prompt goes in `instructions`, never as a "system" message
//   - leave out temperature, max_output_tokens, metadata, user and friends
// Docs: https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference

import { getAccessToken, SignedOutError } from './tokens.js';

const API = 'https://api.openai.com/v1';

// Make it your own: this is the agent's personality.
export const SYSTEM_PROMPT = 'You are byo sub, a friendly assistant running on the user\'s own computer. Keep answers short, clear and warm.';

// Error codes OpenAI uses for plan usage, mapped to what the page should show.
const FRIENDLY = {
  subscription_sharing_usage_limit_exceeded: 'limit',
  subscription_sharing_user_not_eligible: 'not_eligible',
  subscription_sharing_usage_unavailable: 'unavailable',
  subscription_sharing_user_unavailable: 'unavailable',
  subscription_sharing_invalid_user: 'auth',
};

class ChatError extends Error {
  constructor(code, detail) {
    super(detail ?? code);
    this.code = code;
  }
}

// Calls the API with your token. If it says 401, refresh the token (when allowed) and try once more.
async function callApi(path, init = {}) {
  const call = (token) => fetch(`${API}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } });
  const res = await call(await getAccessToken());
  if (res.status !== 401) return res;
  const fresh = await getAccessToken({ force: true });
  return fresh ? call(fresh) : res;
}

// Turns a failed response into a ChatError. Bodies vary: { error: { code } } or just { detail }.
async function failure(res) {
  const body = await res.json().catch(() => ({}));
  const code = body.error?.code ?? null;
  console.error(`OpenAI API error: HTTP ${res.status} ${code ?? body.detail ?? ''} (request ${res.headers.get('x-request-id') ?? 'n/a'})`);
  if (FRIENDLY[code]) return new ChatError(FRIENDLY[code]);
  if (res.status === 401) return new ChatError('auth');
  if (res.status === 503) return new ChatError('unavailable');
  return new ChatError('error', code ?? body.error?.message ?? body.detail ?? `HTTP ${res.status}`);
}

// The models your account can use, in OpenAI's order. The first one is the default.
export async function listModels() {
  const res = await callApi('/models', { headers: { accept: 'application/json' } });
  if (!res.ok) throw await failure(res);
  const { models = [] } = await res.json();
  return models
    .filter((m) => m.visibility === 'list')
    .map((m) => ({ slug: m.slug, name: m.display_name ?? m.slug }));
}

// Streams one reply. `messages` is the whole chat so far: [{ role: 'user' | 'assistant', content }].
// `send` receives { type: 'delta', text } as words arrive, then { type: 'done' } or { type: 'error', code }.
export async function streamReply({ model, messages }, send, signal) {
  try {
    const res = await callApi('/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        model,
        instructions: SYSTEM_PROMPT,
        input: messages.map(({ role, content }) => ({ role, content })),
        store: false,
        stream: true,
      }),
      signal,
    });
    if (!res.ok) throw await failure(res);

    // The reply arrives as Server-Sent Events: blocks of "data: {json}" separated by blank lines.
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
      let gap;
      while ((gap = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, gap);
        buffer = buffer.slice(gap + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!data || data === '[DONE]') continue;
        const event = JSON.parse(data);

        if (event.type === 'response.output_text.delta') send({ type: 'delta', text: event.delta });
        // Only response.completed means success. A usage limit can still arrive mid-stream as response.failed.
        else if (event.type === 'response.completed') {
          // How many tokens this reply used, so the page can show a running total for the chat.
          const { input_tokens = 0, output_tokens = 0, total_tokens = 0 } = event.response?.usage ?? {};
          return send({ type: 'done', usage: { input: input_tokens, output: output_tokens, total: total_tokens } });
        }
        else if (event.type === 'response.failed' || event.type === 'error') {
          const code = event.response?.error?.code ?? event.error?.code ?? event.code;
          console.error(`Stream failed: ${code ?? 'unknown'}`);
          throw new ChatError(FRIENDLY[code] ?? 'error', code);
        } else if (event.type === 'response.incomplete') {
          throw new ChatError('incomplete', event.response?.incomplete_details?.reason);
        }
      }
    }
    throw new ChatError('interrupted'); // the stream ended without response.completed
  } catch (err) {
    if (signal?.aborted) return; // you closed the tab or pressed stop
    if (err instanceof SignedOutError) return send({ type: 'error', code: 'signed_out' });
    if (err instanceof ChatError) return send({ type: 'error', code: err.code, detail: err.message });
    console.error(`Chat failed: ${err.message}`);
    send({ type: 'error', code: 'error', detail: 'Could not reach OpenAI' });
  }
}

export { ChatError };
