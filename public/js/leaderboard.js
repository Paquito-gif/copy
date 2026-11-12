import { $, api, el, avatar, usd, ago, short, reveal } from './common.js';

const LABEL = { '24h': '24 h', '7d': '7 jours', '30d': '30 jours' };
const money = (n) => (n == null ? '–' : `${Math.round(n).toLocaleString('fr-FR')} $`);

function copiedChip() { return el('span', { class: 'chip chip--pump copied' }, el('span', { class: 'live', 'aria-hidden': 'true', style: 'background:#04140b' }), 'Copié'); }

function holdings(list) {
  if (!list?.length) return el('span', { class: 'muted' }, '–');
  return el('span', { class: 'holds', title: list.map((h) => h.symbol).join(', ') }, list.map((h) => h.icon
    ? el('img', { src: h.icon, alt: h.symbol, loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() })
    : el('span', { class: 'chip' }, h.symbol)));
}

function render(lb) {
  const [first, second, third] = lb.traders;
  const pod = (t, n) => t ? el('article', { class: `sticker pod pod--${n}`, 'data-reveal': true },
    el('span', { class: 'pod__rank' }, `#${t.rank}`),
    t.copied ? copiedChip() : null,
    avatar(t.avatarUrl, t.handle),
    el('div', {}, el('div', { class: 'pod__name' }, `@${t.handle}`), t.displayName && t.displayName !== t.handle ? el('span', { class: 'muted' }, t.displayName) : null),
    el('div', { class: `pod__pnl ${t.pnlUsd >= 0 ? 'up' : 'down'}` }, usd(t.pnlUsd)),
    el('span', { class: 'muted mono', style: 'font-size:13px' }, `${money(t.volumeUsd)} de volume · ${t.trades ?? '–'} trades`)) : el('div');
  $('podium').replaceChildren(pod(second, 2), pod(first, 1), pod(third, 3));

  $('rows').replaceChildren(...lb.traders.slice(3).map((t) => el('tr', { class: t.copied ? 'is-copied' : null },
    el('td', {}, el('span', { class: 'rank' }, t.rank)),
    el('td', {}, el('div', { class: 'who' }, avatar(t.avatarUrl, t.handle, 'avatar--sm'),
      el('div', {}, el('b', {}, `@${t.handle}`, t.copied ? el('span', { class: 'chip chip--pump', style: 'margin-left:8px;font-size:11px;padding:3px 8px' }, 'Copié') : null),
        el('span', {}, t.displayName && t.displayName !== t.handle ? t.displayName : (t.solana[0] ? short(t.solana[0]) : 'wallet Solana inconnu'))))),
    el('td', { class: `num ${t.pnlUsd >= 0 ? 'up' : 'down'}` }, usd(t.pnlUsd)),
    el('td', { class: 'num hide-sm' }, money(t.volumeUsd)),
    el('td', { class: 'num hide-sm' }, t.trades ?? '–'),
    el('td', { class: 'hide-sm' }, holdings(t.topHoldings)),
    el('td', { class: 'hide-sm' }, t.solana[0] ? el('a', { class: 'linkbtn', href: `https://solscan.io/account/${t.solana[0]}`, target: '_blank', rel: 'noopener' }, 'Solscan') : el('span', { class: 'muted' }, '–')))));

  $('source').textContent = lb.syncedAt ? `Classement synchronisé ${ago(Date.parse(lb.syncedAt))}` : '';
  $('copied-window').textContent = LABEL[lb.copiedWindow] ?? lb.copiedWindow;
  reveal();
}

async function load(w) {
  document.querySelectorAll('.windows button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.w === w)));
  $('podium').style.opacity = '.4';
  try { render(await api(`/api/leaderboard?window=${w}`)); }
  catch (e) { $('podium').replaceChildren(el('div', { class: 'empty', style: 'grid-column:1/-1' }, el('b', {}, 'Classement indisponible'), e.message)); $('rows').replaceChildren(); }
  finally { $('podium').style.opacity = ''; }
}

document.querySelectorAll('.windows button').forEach((b) => b.addEventListener('click', () => load(b.dataset.w)));
load('24h');
