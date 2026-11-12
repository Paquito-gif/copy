/* Shared by every page: API, formatting, engine state, motion helpers, wallet. */
const motionOK = !matchMedia('(prefers-reduced-motion: reduce)').matches;
if (motionOK) document.documentElement.classList.add('anim');

const LOCALE = 'en-US';
export const $ = (id) => document.getElementById(id);
export const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '–');
export const fmt = (n, d = 3) => Number(n || 0).toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d });
export const sol = (n, d = 3) => `${fmt(n, d)} SOL`;
export const signed = (n, d = 3) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt(Math.abs(n), d)}`;
/** Compact USD: +$107.8K, $96,300, −$1.2M */
export const usd = (n, { sign = true, compact = true } = {}) => {
  if (n == null || Number.isNaN(n)) return '–';
  const a = Math.abs(n);
  const body = compact && a >= 1000
    ? a.toLocaleString(LOCALE, { notation: 'compact', maximumFractionDigits: a >= 1e6 ? 2 : 1 })
    : a.toLocaleString(LOCALE, { maximumFractionDigits: a < 10 ? 2 : 0 });
  return `${sign ? (n >= 0 ? '+' : '−') : ''}$${body}`;
};
export const ago = (t) => {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== '') e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

export async function api(path, body) {
  const r = await fetch(path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
  return data;
}

/** Site config, fetched once per page. */
let cfgP;
export const config = () => (cfgP ??= api('/api/config'));

/** One engine state for the whole site: paused, simulation or live. */
export const ENGINE_TEXT = { paused: 'Engine paused', simulation: 'Simulating', live: 'Copying live' };
export async function engineState() {
  try { return (await config()).engine?.state ?? 'paused'; } catch { return 'paused'; }
}
/** Chip for the copy target: "Copying" only when the engine actually runs. */
export function targetChip(state, small = false) {
  const on = state !== 'paused';
  return el('span', { class: `chip ${on ? 'chip--up' : ''} ${small ? 'chip--xs' : ''}` },
    el('span', { class: `live ${state === 'live' ? '' : 'live--off'}`, 'aria-hidden': 'true' }),
    state === 'live' ? 'Copying' : state === 'simulation' ? 'Copying (simulated)' : 'Next to copy');
}

/** FOMO profile picture when available, the initial otherwise. */
export function avatar(url, name, cls = '') {
  const fallback = () => el('span', { class: `avatar ${cls}`, 'aria-hidden': 'true' }, (name || '?').replace('@', '').slice(0, 1).toUpperCase());
  if (!url) return fallback();
  const img = el('img', { class: `avatar ${cls}`, src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
  return img;
}

/** Counts a number up to its value. */
export function countTo(node, value, { decimals = 3, prefix = '', suffix = '', signedValue = false, duration = 1100 } = {}) {
  const render = (v) => {
    const sign = signedValue ? (v > 0 ? '+' : v < 0 ? '−' : '') : (v < 0 ? '−' : '');
    node.textContent = `${prefix}${sign}${fmt(Math.abs(v), decimals)}${suffix}`;
  };
  if (!motionOK || !Number.isFinite(value) || value === 0) { render(value || 0); return; }
  const start = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - start) / duration);
    render(value * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Scroll reveals: [data-reveal] blocks rise into place, [data-seq] groups play their children in order. */
export function reveal(root = document) {
  const items = root.querySelectorAll('[data-reveal]:not(.is-in), [data-seq]:not(.is-in)');
  if (!motionOK || !('IntersectionObserver' in window)) { items.forEach((n) => n.classList.add('is-in')); return; }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -12% 0px' });
  let i = 0;
  items.forEach((n) => {
    if (n.hasAttribute('data-reveal') && !n.style.getPropertyValue('--delay')) n.style.setProperty('--delay', `${(i++ % 5) * 70}ms`);
    io.observe(n);
  });
  setTimeout(() => items.forEach((n) => n.classList.add('is-in')), 6000); // safety net for previews and captures
}

/** Counts a USD figure from `from` (0 by default) to its value, keeping the compact format. */
export function countUsd(node, value, from = 0) {
  if (!motionOK || !Number.isFinite(value)) { node.textContent = usd(value); return; }
  const start = performance.now(), dur = from ? 900 : 1300;
  const step = (now) => {
    const k = Math.min(1, (now - start) / dur);
    node.textContent = usd(from + (value - from) * (1 - Math.pow(1 - k, 4)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Brief green or red wash on a value that just changed. */
export function flash(node, up) {
  node.classList.remove('flash-up', 'flash-down'); void node.offsetWidth;
  node.classList.add(up ? 'flash-up' : 'flash-down');
}

/** Runs fn every ms while the tab is visible. */
export function every(ms, fn) {
  setInterval(() => { if (document.visibilityState === 'visible') fn(); }, ms);
}

// ---------- 3D details ----------
const FACES = {
  logo: '<svg viewBox="0 0 32 32"><rect x="7" y="9" width="7" height="16" rx="2" fill="currentColor"/><path d="M10.5 5v4M10.5 25v3" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><rect x="18" y="5" width="7" height="16" rx="2" fill="currentColor" opacity=".6"/><path d="M21.5 2v3M21.5 21v4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" opacity=".6"/></svg>',
  burn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22c4 0 7-2.7 7-6.6 0-4.4-4.2-6.4-5-11.4-2.6 1.8-4.2 4.5-4.2 7.2-1-.8-1.6-2-1.8-3.2C6.6 9.6 5 12.3 5 15.4 5 19.3 8 22 12 22z"/></svg>',
};
/** Builds a real 3D coin: two faces and a stack of rim layers for thickness. */
function buildCoins() {
  document.querySelectorAll('.coin3d:empty').forEach((c) => {
    const body = el('div', { class: 'coin3d__body' });
    for (let z = -5; z <= 5; z++) body.append(el('i', { style: `transform: translateZ(${z * 0.9}px)` }));
    const face = FACES[c.dataset.face] ?? FACES.logo;
    const front = el('b', { class: 'coin3d__face' }); front.innerHTML = face;
    const back = el('b', { class: 'coin3d__face coin3d__face--back' }); back.innerHTML = face;
    body.append(front, back);
    c.append(body);
  });
}

/** Card leans toward the pointer, with a light sheen that follows it. Fine pointers only. */
export function tilt(nodes, max = 7) {
  if (!motionOK || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  nodes.forEach((n) => {
    if (n.dataset.tilt) return;
    n.dataset.tilt = '1';
    n.classList.add('tilt');
    let raf = 0;
    n.addEventListener('pointermove', (e) => {
      const r = n.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        n.style.setProperty('--ry', `${(x - 0.5) * max * 2}deg`);
        n.style.setProperty('--rx', `${(0.5 - y) * max * 2}deg`);
        n.style.setProperty('--mx', `${x * 100}%`);
        n.style.setProperty('--my', `${y * 100}%`);
        n.classList.add('is-tilting');
      });
    });
    n.addEventListener('pointerleave', () => {
      cancelAnimationFrame(raf);
      n.classList.remove('is-tilting');
      n.style.setProperty('--rx', '0deg'); n.style.setProperty('--ry', '0deg');
    });
  });
}

/** Scroll-linked values: --sy on the root (px scrolled), sticky header state. */
function scrollFx() {
  const root = document.documentElement, top = document.querySelector('.top');
  let ticking = false;
  const update = () => {
    ticking = false;
    const y = scrollY;
    if (motionOK) root.style.setProperty('--sy', String(Math.min(y, 1600)));
    const max = root.scrollHeight - innerHeight;
    root.style.setProperty('--progress', max > 0 ? (y / max).toFixed(4) : '0');
    top?.classList.toggle('is-scrolled', y > 8);
  };
  addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  update();
}

// ---------- wallet ----------
export const walletState = { provider: null, address: null };
function findProvider() {
  if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
  if (window.solflare?.isSolflare) return window.solflare;
  if (window.backpack?.isBackpack) return window.backpack;
  return window.solana || null;
}
const setWalletLabel = (text, on = false) => {
  const b = $('wallet-btn');
  if (!b) return;
  b.classList.toggle('is-on', on);
  b.lastChild.textContent = text;
};
export async function connectWallet() {
  walletState.provider = findProvider();
  if (!walletState.provider) return false;
  const res = await walletState.provider.connect();
  walletState.address = (res?.publicKey || walletState.provider.publicKey).toString();
  setWalletLabel(short(walletState.address), true);
  document.dispatchEvent(new CustomEvent('wallet', { detail: walletState.address }));
  return true;
}
function initWallet() {
  $('wallet-btn')?.addEventListener('click', async () => {
    try {
      if (!(await connectWallet())) { setWalletLabel('Get Phantom'); window.open('https://phantom.com/download', '_blank', 'noopener'); }
    } catch { setWalletLabel('Request declined'); setTimeout(() => setWalletLabel('Connect'), 2500); }
  });
  const p = findProvider();
  p?.connect?.({ onlyIfTrusted: true }).then((res) => {
    walletState.provider = p;
    walletState.address = (res?.publicKey || p.publicKey)?.toString() ?? null;
    if (walletState.address) { setWalletLabel(short(walletState.address), true); document.dispatchEvent(new CustomEvent('wallet', { detail: walletState.address })); }
  }).catch(() => {});
}

/** Header status: the engine state, not a decorative network pill. */
async function initEngineStatus() {
  const n = $('engine-status');
  if (!n) return;
  const state = await engineState();
  n.dataset.state = state;
  n.lastChild.textContent = ENGINE_TEXT[state];
  n.title = state === 'paused' ? 'The copy-trading engine is paused. Fees still accrue to the public wallet.' : '';
}

/** A pill that slides under the hovered nav link. */
function initNavPill() {
  const nav = $('nav');
  if (!nav || !motionOK) return;
  const pill = el('span', { class: 'nav__pill', 'aria-hidden': 'true' });
  nav.prepend(pill);
  const move = (a) => {
    if (matchMedia('(max-width: 820px)').matches) return;
    pill.style.width = `${a.offsetWidth}px`;
    pill.style.transform = `translateX(${a.offsetLeft}px)`;
    pill.classList.add('is-on');
  };
  nav.querySelectorAll('a').forEach((a) => { a.addEventListener('pointerenter', () => move(a)); a.addEventListener('focus', () => move(a)); });
  nav.addEventListener('pointerleave', () => pill.classList.remove('is-on'));
}

/** Card borders light up where the pointer is. */
function initSpotlight() {
  if (!motionOK || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  let raf = 0, e = null;
  addEventListener('pointermove', (ev) => {
    e = ev;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const card = e.target.closest?.('.card');
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty('--px', `${e.clientX - r.left}px`);
      card.style.setProperty('--py', `${e.clientY - r.top}px`);
    });
  }, { passive: true });
}

// ---------- navigation: active page + mobile menu ----------
function markActive() {
  const path = location.pathname.replace(/\/$/, '') || '/';
  document.querySelectorAll('.nav a').forEach((a) => {
    if ((a.getAttribute('href').replace(/\/$/, '') || '/') === path) a.setAttribute('aria-current', 'page');
  });
}
function initMenu() {
  const btn = $('menu-btn'), nav = $('nav');
  if (!btn || !nav) return;
  const set = (open) => { nav.classList.toggle('is-open', open); btn.setAttribute('aria-expanded', String(open)); btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu'); };
  btn.addEventListener('click', () => set(!nav.classList.contains('is-open')));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') set(false); });
  document.addEventListener('click', (e) => { if (!nav.contains(e.target) && !btn.contains(e.target)) set(false); });
}

buildCoins();
scrollFx();
markActive();
initMenu();
initNavPill();
initSpotlight();
initEngineStatus();
initWallet();
reveal();
