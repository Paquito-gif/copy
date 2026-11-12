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

/** Fade-in on scroll; everything is visible without JS or with reduced motion. */
export function reveal(root = document) {
  const items = root.querySelectorAll('[data-reveal]:not(.is-in)');
  if (!motionOK || !('IntersectionObserver' in window)) { items.forEach((n) => n.classList.add('is-in')); return; }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -6% 0px' });
  items.forEach((n, i) => { if (!n.style.getPropertyValue('--delay')) n.style.setProperty('--delay', `${(i % 4) * 60}ms`); io.observe(n); });
  setTimeout(() => items.forEach((n) => n.classList.add('is-in')), 4000); // safety net for previews and captures
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

markActive();
initMenu();
initEngineStatus();
initWallet();
reveal();
