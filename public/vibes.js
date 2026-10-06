// vibes.js: switches between chat styles ("vibes") with the arrows at the edges of
// the chat, the ← → keys, or a swipe. Each vibe is one CSS file in public/vibes/.
//
// To add your own: copy a file in public/vibes/, change the name inside it, add a
// <link> for it in index.html, and add it to the list below.

import { paintBubble, paintScene } from './paint.js';
import { calm } from './effects.js';

// `reveal` is how replies appear: 'type' letter by letter, or 'words' one word at a time.
export const VIBES = [
  { id: 'classic', name: 'Classic', reveal: 'type' },
  { id: 'receipt', name: 'Receipt', reveal: 'type' },
  { id: 'terminal', name: 'Terminal', reveal: 'type' },
  { id: 'comic', name: 'Comic', reveal: 'words' },
  { id: 'painted', name: 'Painted', reveal: 'words' },
];

const root = document.documentElement;
const $ = (id) => document.getElementById(id);
let current = VIBES[0];
let active = false; // vibes only apply on the chat screen
try { current = VIBES.find((v) => v.id === localStorage.getItem('vibe')) ?? current; } catch {}

export const currentVibe = () => current;
const theme = () => root.dataset.theme;
const painted = () => active && current.id === 'painted';

// Turn vibes on when the chat screen shows, off when it hides.
export function showVibes(on) {
  active = on;
  if (on) root.dataset.vibe = current.id;
  else delete root.dataset.vibe;
  if (painted()) paintScene($('scene'), theme());
  updateDots();
}

// Called for every new message: starts its entrance and, in Painted, paints its bubble.
export function vibeIn(li) {
  li.classList.add('enter');
  if (painted()) paintBubble(li.querySelector('.bubble'), { animate: !calm(), theme: theme() });
}

// A reply grows while it streams, so repaint its wash (same brush marks, bigger) as it does.
const grower = new ResizeObserver((entries) => {
  if (!painted()) return;
  for (const { target } of entries) if (target.querySelector('canvas.paint')) paintBubble(target, { theme: theme() });
});
export const watchBubble = (bubble) => grower.observe(bubble);

// Repaint everything after a day/night switch.
export function vibeThemeChanged() {
  if (!painted()) return;
  paintScene($('scene'), theme());
  document.querySelectorAll('#messages .bubble').forEach((b) => paintBubble(b, { theme: theme() }));
}

function setVibe(vibe) {
  current = vibe;
  try { localStorage.setItem('vibe', vibe.id); } catch {}
  root.dataset.vibe = vibe.id;
  updateDots();
  if (painted()) paintScene($('scene'), theme());

  // Flash the vibe's name in its own font.
  const label = $('vibe-name');
  label.textContent = vibe.name;
  label.classList.remove('show');
  void label.offsetWidth; // restart the animation
  label.classList.add('show');

  // The same conversation re-enters in the new style, one message after another.
  [...$('messages').children].forEach((li, i) => {
    li.classList.remove('enter');
    void li.offsetWidth;
    li.style.setProperty('--d', `${i * 90}ms`);
    vibeIn(li);
  });
}

function step(direction) {
  root.setAttribute('data-vibes-used', ''); // stop the arrows nudging once someone has found them
  const i = VIBES.indexOf(current);
  setVibe(VIBES[(i + direction + VIBES.length) % VIBES.length]);
}

function updateDots() {
  [...$('vibe-dots').children].forEach((dot, i) => dot.classList.toggle('on', VIBES[i] === current));
  const i = VIBES.indexOf(current);
  $('vibe-prev').setAttribute('aria-label', `Previous style: ${VIBES[(i - 1 + VIBES.length) % VIBES.length].name}`);
  $('vibe-next').setAttribute('aria-label', `Next style: ${VIBES[(i + 1) % VIBES.length].name}`);
}

export function setupVibes() {
  $('vibe-dots').replaceChildren(...VIBES.map(() => document.createElement('i')));
  $('vibe-prev').addEventListener('click', () => step(-1));
  $('vibe-next').addEventListener('click', () => step(1));
  document.addEventListener('keydown', (e) => {
    if (!active || e.target.closest('input, textarea, select, .menu')) return;
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });
  let startX = null;
  $('messages').addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
  $('messages').addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - (startX ?? e.changedTouches[0].clientX);
    if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1);
    startX = null;
  });
  let resizing;
  addEventListener('resize', () => {
    clearTimeout(resizing);
    resizing = setTimeout(() => { if (painted()) paintScene($('scene'), theme()); }, 200);
  });
  updateDots();
}
