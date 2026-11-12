/* Commun à toutes les pages : API, formats, bandeau du classement, animations, wallet. */
const motionOK = !matchMedia('(prefers-reduced-motion: reduce)').matches;
if (motionOK) document.documentElement.classList.add('anim');

export const $ = (id) => document.getElementById(id);
export const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '–');
export const fmt = (n, d = 3) => Number(n || 0).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
export const sol = (n, d = 3) => `${fmt(n, d)} SOL`;
export const usd = (n, signed = true) => {
  if (n == null || Number.isNaN(n)) return '–';
  const s = Math.abs(n) >= 1000 ? Math.round(Math.abs(n)).toLocaleString('fr-FR') : Math.abs(n).toLocaleString('fr-FR', { maximumFractionDigits: 2 });
  return `${signed ? (n >= 0 ? '+' : '−') : ''}${s} $`;
};
export const signed = (n, d = 3) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt(Math.abs(n), d)}`;
export const ago = (t) => {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'à l’instant';
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `il y a ${h} h` : `il y a ${Math.round(h / 24)} j`;
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
  if (!r.ok) throw new Error(data.error || `Erreur ${r.status}`);
  return data;
}

/** Avatar : photo FOMO si dispo, sinon l'initiale. */
export function avatar(url, name, cls = '') {
  const fallback = () => el('span', { class: `avatar ${cls}`, 'aria-hidden': 'true' }, (name || '?').replace('@', '').slice(0, 1).toUpperCase());
  if (!url) return fallback();
  const img = el('img', { class: `avatar ${cls}`, src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
  return img;
}

/** Compteur qui s'anime jusqu'à sa valeur. */
export function countTo(node, value, { decimals = 3, prefix = '', suffix = '', signedValue = false, duration = 1200 } = {}) {
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

/** Apparition des blocs au scroll (contenu visible par défaut sans JS / sans mouvement). */
export function reveal(root = document) {
  const items = root.querySelectorAll('[data-reveal]:not(.is-in)');
  if (!motionOK || !('IntersectionObserver' in window)) { items.forEach((n) => n.classList.add('is-in')); return; }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px' });
  items.forEach((n, i) => { if (!n.style.getPropertyValue('--delay')) n.style.setProperty('--delay', `${(i % 4) * 70}ms`); io.observe(n); });
  // sécurité : si rien ne fait défiler la page (capture, aperçu, impression), tout s'affiche quand même
  setTimeout(() => items.forEach((n) => n.classList.add('is-in')), 4000);
}

/** Bandeau défilant : le top du classement FOMO. */
async function loadTape() {
  const track = $('tape-track');
  if (!track) return;
  try {
    const lb = await api('/api/leaderboard?window=24h');
    const items = lb.traders.slice(0, 10).map((t) => el('span', { class: 'tape__item' },
      el('span', {}, `#${t.rank}`),
      t.avatarUrl ? el('img', { src: t.avatarUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null,
      `@${t.handle}`,
      el('b', {}, usd(t.pnlUsd)),
      t.copied ? el('span', {}, '· copié') : null,
      el('i', { class: 'tape__sep', 'aria-hidden': 'true' })));
    if (!items.length) return;
    track.replaceChildren(...items, ...items.map((n) => n.cloneNode(true)));
    track.parentElement.setAttribute('aria-label', `Classement FOMO 24 h : ${lb.traders.slice(0, 3).map((t) => `#${t.rank} @${t.handle} ${usd(t.pnlUsd)}`).join(', ')}`);
  } catch {
    track.parentElement.hidden = true;
  }
}

// ---------- wallet ----------
export const walletState = { provider: null, address: null };
function findProvider() {
  if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
  if (window.solflare?.isSolflare) return window.solflare;
  if (window.backpack?.isBackpack) return window.backpack;
  return window.solana || null;
}
export async function connectWallet() {
  walletState.provider = findProvider();
  if (!walletState.provider) return false;
  const res = await walletState.provider.connect();
  walletState.address = (res?.publicKey || walletState.provider.publicKey).toString();
  const b = $('wallet-btn');
  if (b) { b.classList.add('is-on'); b.lastChild.textContent = short(walletState.address); }
  return true;
}
function initWalletButton() {
  const b = $('wallet-btn');
  if (!b) return;
  b.addEventListener('click', async () => {
    try {
      if (!(await connectWallet())) { b.lastChild.textContent = 'Installer Phantom'; window.open('https://phantom.com/download', '_blank', 'noopener'); }
    } catch { b.lastChild.textContent = 'Connexion refusée'; setTimeout(() => { b.lastChild.textContent = 'Connecter'; }, 2500); }
  });
  // reconnexion silencieuse si le wallet a déjà autorisé le site
  const p = findProvider();
  p?.connect?.({ onlyIfTrusted: true }).then((res) => {
    walletState.provider = p;
    walletState.address = (res?.publicKey || p.publicKey)?.toString() ?? null;
    if (walletState.address) { b.classList.add('is-on'); b.lastChild.textContent = short(walletState.address); }
  }).catch(() => {});
}

// ---------- onglet actif ----------
function markTab() {
  const path = location.pathname.replace(/\/$/, '') || '/';
  document.querySelectorAll('.tabs a').forEach((a) => {
    if ((a.getAttribute('href').replace(/\/$/, '') || '/') === path) a.setAttribute('aria-current', 'page');
  });
}

markTab();
initWalletButton();
loadTape();
reveal();
