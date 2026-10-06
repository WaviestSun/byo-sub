// paint.js: the watercolour engine behind the Painted vibe.
//
// The trick: real watercolour is many thin, transparent layers of paint. So we take
// a shape, roughen its edges a little differently each time, and fill it twenty-odd
// times at about 6% opacity. The overlaps build up soft edges and a darker middle.

// A tiny random number generator that can be replayed from a seed, so a bubble
// keeps the same brush marks when it's repainted as a reply grows.
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const P = (x, y) => ({ x, y });
const ellipse = (cx, cy, rx, ry, n = 10) =>
  Array.from({ length: n }, (_, i) => P(cx + Math.cos((i / n) * Math.PI * 2) * rx, cy + Math.sin((i / n) * Math.PI * 2) * ry));

// A rounded rectangle traced as many short steps, so the wobble stays fine on long bubbles.
function roundedBox(x, y, w, h, r, step = 36) {
  const pts = [];
  const line = (x1, y1, x2, y2) => {
    const n = Math.max(1, Math.round(Math.hypot(x2 - x1, y2 - y1) / step));
    for (let i = 0; i < n; i++) pts.push(P(x1 + ((x2 - x1) * i) / n, y1 + ((y2 - y1) * i) / n));
  };
  const corner = (cx, cy, from) => {
    for (let i = 0; i < 3; i++) pts.push(P(cx + Math.cos(from + (i / 3) * (Math.PI / 2)) * r, cy + Math.sin(from + (i / 3) * (Math.PI / 2)) * r));
  };
  line(x + r, y, x + w - r, y); corner(x + w - r, y + r, -Math.PI / 2);
  line(x + w, y + r, x + w, y + h - r); corner(x + w - r, y + h - r, 0);
  line(x + w - r, y + h, x + r, y + h); corner(x + r, y + h - r, Math.PI / 2);
  line(x, y + h - r, x, y + r); corner(x + r, y + r, Math.PI);
  return pts;
}

// Splits every edge in two and nudges the new point sideways, `depth` times over.
function roughen(points, depth, amount, rand) {
  const wobble = () => (rand() + rand() + rand() - 1.5) / 1.5;
  for (let d = 0; d < depth; d++) {
    const out = [];
    points.forEach((a, i) => {
      const b = points[(i + 1) % points.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      out.push(a, P((a.x + b.x) / 2 + wobble() * amount * len, (a.y + b.y) / 2 + wobble() * amount * len));
    });
    points = out;
  }
  return points;
}

// One colour wash = many slightly different layers of the same rough shape.
function wash(shape, color, layers, alpha, amount, rand) {
  const base = roughen(shape, 2, amount, rand);
  return Array.from({ length: layers }, () => ({ points: roughen(base, 3, amount * 0.7, rand), color, alpha }));
}

function fill(ctx, { points, color, alpha, edge }) {
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  if (edge) {
    // Watercolour dries darker at its edges, so trace a few faint outlines.
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  } else {
    ctx.fillStyle = color;
    ctx.fill();
  }
}

function sizeCanvas(canvas, w, h) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

// Your messages are lavender; replies take turns between ochre, teal and peach.
const PIGMENTS = {
  day: { user: [['#9B7FD0', '#C9A3E8']], assistant: [['#F2B33D', '#F29E8E'], ['#5FB3B3', '#9FD3C7'], ['#F29E8E', '#F6C177']] },
  night: { user: [['#7E6BC4', '#B39BEA']], assistant: [['#D9822B', '#E8B04F'], ['#2E7FA5', '#5FB3C9'], ['#8C6FB5', '#D98AA0']] },
};
let bubbleCount = 0;

// Paints the wash behind one message bubble. With `animate`, it builds up layer by layer.
export async function paintBubble(bubble, { animate = false, theme = 'day' } = {}) {
  const canvas = bubble.querySelector('canvas.paint') ?? bubble.insertBefore(Object.assign(document.createElement('canvas'), { className: 'paint' }), bubble.firstChild);
  bubble.dataset.seed ??= String(Math.floor(Math.random() * 1e9));
  bubble.dataset.pigment ??= String(bubbleCount++);
  const rand = seeded(Number(bubble.dataset.seed));
  const role = bubble.closest('.msg')?.classList.contains('user') ? 'user' : 'assistant';
  const sets = PIGMENTS[theme][role];
  const [main, second] = sets[Number(bubble.dataset.pigment) % sets.length];

  const m = 28; // room for the paint to spill past the bubble without being cut off
  const w = bubble.offsetWidth + m * 2, h = bubble.offsetHeight + m * 2;
  const ctx = sizeCanvas(canvas, w, h);
  canvas.style.left = canvas.style.top = `${-m}px`;
  const x = m - 6, y = m - 4, bw = w - 2 * m + 12, bh = h - 2 * m + 8, r = Math.min(bh / 2, 22);
  const box = roundedBox(x, y, bw, bh, r);
  // a second colour bleeding in from one side
  const bleed = roundedBox(rand() < 0.5 ? x : x + bw * 0.45, y + bh * 0.08, bw * 0.55, bh * 0.84, r * 0.8);
  const alpha = theme === 'night' ? 0.075 : 0.06;
  const edges = wash(box, main, 3, alpha * 2, 0.22, rand).map((layer) => ({ ...layer, edge: true }));
  const layers = [...wash(box, main, 18, alpha, 0.22, rand), ...wash(bleed, second, 10, alpha, 0.28, rand), ...edges];

  ctx.clearRect(0, 0, w, h);
  if (!animate) return layers.forEach((layer) => fill(ctx, layer));
  canvas.classList.add('brush'); // a CSS mask sweeps across, like a brush stroke
  for (let i = 0; i < layers.length; i++) {
    fill(ctx, layers[i]);
    if (i % 2) await new Promise(requestAnimationFrame);
  }
}

// Paints the whole landscape behind the app: Provence by day, a mountain lake by night.
export function paintScene(canvas, theme) {
  const W = innerWidth, H = innerHeight;
  const ctx = sizeCanvas(canvas, W, H);
  const rand = seeded(7);
  const L = [];
  const add = (shape, color, layers = 14, alpha = 0.06, amount = 0.06) => L.push(...wash(shape, color, layers, alpha, amount, rand));

  if (theme === 'day') {
    ctx.fillStyle = '#FBF4E6';
    ctx.fillRect(0, 0, W, H);
    add([P(-20, -20), P(W + 20, -20), P(W + 20, H * 0.3), P(-20, H * 0.3)], '#F6A9A0', 12, 0.05); // pink sky
    add([P(-20, H * 0.12), P(W + 20, H * 0.08), P(W + 20, H * 0.3), P(-20, H * 0.32)], '#FBC98E', 10, 0.05); // peach glow
    add([P(-20, H * 0.36), P(-20, H * 0.22), P(W * 0.2, H * 0.15), P(W * 0.38, H * 0.21), P(W * 0.6, H * 0.13), P(W * 0.82, H * 0.2), P(W + 20, H * 0.16), P(W + 20, H * 0.36)], '#3E63B8', 16); // mountains
    add([P(-20, H * 0.4), P(-20, H * 0.27), P(W * 0.3, H * 0.24), P(W * 0.55, H * 0.29), P(W * 0.85, H * 0.23), P(W + 20, H * 0.27), P(W + 20, H * 0.4)], '#6E9BD1', 12, 0.05);
    add([P(-20, H * 0.64), P(-20, H * 0.36), P(W * 0.25, H * 0.31), P(W * 0.55, H * 0.35), P(W * 0.8, H * 0.3), P(W + 20, H * 0.34), P(W + 20, H * 0.64)], '#F2B33D', 16); // ochre hills
    add(ellipse(W * 0.18, H * 0.43, W * 0.2, H * 0.05), '#8DB580', 12, 0.06, 0.08);
    add(ellipse(W * 0.82, H * 0.47, W * 0.17, H * 0.045), '#5FA88C', 12, 0.06, 0.08);
    add([P(W * 0.44, H * 0.3), P(W * 0.52, H * 0.3), P(W * 0.52, H * 0.345), P(W * 0.44, H * 0.345)], '#F7E3C4', 8, 0.12, 0.02); // a little house
    add([P(W * 0.43, H * 0.302), P(W * 0.48, H * 0.274), P(W * 0.53, H * 0.302)], '#E07A4F', 8, 0.12, 0.02);
    for (const cx of [0.1, 0.62, 0.66, 0.7, 0.9]) add([P(W * cx, H * 0.2), P(W * cx + 9, H * 0.33), P(W * cx - 9, H * 0.33)], '#2F5D3A', 9, 0.1, 0.03); // cypresses
    add([P(-20, H), P(-20, H * 0.62), P(W * 0.5, H * 0.58), P(W + 20, H * 0.62), P(W + 20, H)], '#F39B4A', 10, 0.04);
    for (let row = 0; row < 4; row++) {
      for (let x = -0.12; x < 1.1; x += 0.12) {
        add(ellipse(W * (x + (row % 2) * 0.06), H * (0.8 + row * 0.055), W * 0.075, H * 0.028), row % 2 ? '#A98AD8' : '#8E6FC1', 6, 0.1, 0.1); // lavender
      }
    }
  } else {
    ctx.fillStyle = '#1B1F33';
    ctx.fillRect(0, 0, W, H);
    add([P(-20, -20), P(W + 20, -20), P(W + 20, H * 0.45), P(-20, H * 0.45)], '#2B2F5A', 12, 0.08); // night sky
    add([P(-20, H * 0.25), P(W + 20, H * 0.22), P(W + 20, H * 0.46), P(-20, H * 0.46)], '#6A4E7E', 10, 0.05);
    add([P(W * 0.05, H * 0.44), P(W * 0.42, H * 0.12), P(W * 0.52, H * 0.1), P(W * 0.96, H * 0.44)], '#8C8FB5', 16); // misty mountain
    add([P(-20, H * 0.46), P(-20, H * 0.38), P(W + 20, H * 0.37), P(W + 20, H * 0.46)], '#C9782F', 10, 0.04);
    const pine = (x, h, color) => add([P(x, H * 0.5 - h), P(x + 18, H * 0.5), P(x - 18, H * 0.5)], color, 8, 0.1, 0.05);
    [0.04, 0.1, 0.17, 0.24, 0.31].forEach((x, i) => pine(W * x, H * (0.18 + (i % 3) * 0.05), i % 2 ? '#D9822B' : '#1F4D4A'));
    [0.68, 0.75, 0.82, 0.89, 0.96].forEach((x, i) => pine(W * x, H * (0.2 + (i % 3) * 0.05), i % 2 ? '#1F4D4A' : '#E0913A'));
    add([P(-20, H + 20), P(-20, H * 0.5), P(W + 20, H * 0.5), P(W + 20, H + 20)], '#2E7FA5', 16, 0.07); // the lake
    add([P(-20, H + 20), P(-20, H * 0.62), P(W + 20, H * 0.6), P(W + 20, H + 20)], '#3FA7B5', 10, 0.05);
    for (const x of [0.1, 0.24, 0.75, 0.89]) add([P(W * x - 20, H * 0.5), P(W * x + 20, H * 0.5), P(W * x + 10, H * 0.72), P(W * x - 10, H * 0.72)], '#D9822B', 6, 0.05, 0.08); // reflections
    for (let i = 0; i < 30; i++) add(ellipse(rand() * W, rand() * H * 0.2, 1.2, 1.2, 6), '#FFF4E2', 1, 0.5, 0.01); // stars
  }
  L.forEach((layer) => fill(ctx, layer));

  // a little paper grain
  ctx.globalAlpha = theme === 'day' ? 0.05 : 0.07;
  ctx.fillStyle = theme === 'day' ? '#5A4630' : '#FFFFFF';
  for (let i = 0; i < (W * H) / 120; i++) ctx.fillRect(rand() * W, rand() * H, 1, 1);
  ctx.globalAlpha = 1;
}
