// effects.js: the fun bits. The boot sequence, the coin sound, and the little
// particle trail behind your messages. Delete this file's imports in app.js
// and the app still works, just quieter.

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- 1. Boot sequence: a terminal types out, then dissolves (under 2 seconds) ----------

export async function runBoot() {
  const boot = document.getElementById('boot');
  if (calm()) return boot.remove();
  boot.hidden = false;
  let skipped = false;
  const skip = () => { skipped = true; };
  boot.addEventListener('click', skip);
  document.addEventListener('keydown', skip, { once: true });

  const lines = [
    ['~/byo-sub $ npm start', ''],
    [`listening on ${location.host}`, ''],
    ['looking for an API key', 'none needed'],
    ['looking for an AI bill', 'none found'],
    ['opening wallet', 'ok'],
  ];
  const log = boot.querySelector('.boot-log');
  for (const [text, result] of lines) {
    const row = document.createElement('div');
    const typed = document.createElement('span');
    row.append(typed);
    log.append(row);
    for (let i = 0; i < text.length && !skipped; i += 2) {
      typed.textContent = text.slice(0, i + 2);
      await wait(9);
    }
    typed.textContent = text;
    if (result) row.append(Object.assign(document.createElement('b'), { textContent: result }));
    if (skipped) break;
    await wait(70);
  }
  boot.classList.add('big');
  if (!skipped) await wait(260);
  boot.classList.add('leaving');
  await wait(skipped ? 120 : 320);
  boot.remove();
  document.removeEventListener('keydown', skip);
}

// ---------- 2. The coin sound, made live with Web Audio (no sound files) ----------
// Browsers only allow sound after you click or tap the page, so primeAudio()
// runs on your first tap and clink() plays once the coin lands.

let audio = null;

export function primeAudio() {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') audio.resume();
  } catch {
    audio = null;
  }
}

export function clink() {
  if (!audio || audio.state !== 'running') return;
  const a = audio;
  const t = a.currentTime + 0.005;
  const out = a.createGain();
  out.gain.value = 0.3;
  out.connect(a.destination);

  // a soft thump as the coin hits the leather
  const thump = a.createOscillator(), thumpGain = a.createGain();
  thump.frequency.setValueAtTime(190, t);
  thump.frequency.exponentialRampToValueAtTime(65, t + 0.1);
  thumpGain.gain.setValueAtTime(0.0001, t);
  thumpGain.gain.exponentialRampToValueAtTime(0.9, t + 0.004);
  thumpGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
  thump.connect(thumpGain).connect(out);
  thump.start(t);
  thump.stop(t + 0.16);

  // a short bright click of metal
  const noise = a.createBuffer(1, Math.floor(a.sampleRate * 0.02), a.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const click = a.createBufferSource(), band = a.createBiquadFilter();
  click.buffer = noise;
  band.type = 'bandpass';
  band.frequency.value = 5200;
  click.connect(band).connect(out);
  click.start(t);

  // the ring: a few out-of-tune tones fading at different speeds, then a smaller bounce
  const ring = (start, loudness) => {
    for (const [freq, amp, length] of [[2637, 1, 0.55], [3951, 0.55, 0.38], [5588, 0.35, 0.26], [7217, 0.2, 0.17]]) {
      const tone = a.createOscillator(), gain = a.createGain();
      tone.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(amp * loudness * 0.45, start + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
      tone.connect(gain).connect(out);
      tone.start(start);
      tone.stop(start + length + 0.05);
    }
  };
  ring(t, 1);
  ring(t + 0.14, 0.4);
}

// ---------- 3. A particle trail behind a message you just sent ----------

export function trail(bubble) {
  if (calm()) return;
  for (let i = 0; i < 7; i++) {
    const dot = document.createElement('i');
    dot.className = 'particle';
    dot.style.setProperty('--x', `${-12 - Math.random() * 46}px`);
    dot.style.setProperty('--y', `${18 + Math.random() * 40}px`);
    dot.style.setProperty('--delay', `${i * 40}ms`);
    dot.addEventListener('animationend', () => dot.remove());
    bubble.append(dot);
  }
}
