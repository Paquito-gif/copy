import { $, api, el, avatar, usd, ago, short, reveal } from './common.js';

const LABEL = { '24h': '24h', '7d': '7-day', '30d': '30-day' };
const vol = (n) => (n == null ? '–' : usd(n, { sign: false }));
const copying = () => el('span', { class: 'chip chip--up' }, el('span', { class: 'live', 'aria-hidden': 'true' }), 'Copying');

function holdings(list) {
  const imgs = (list ?? []).filter((h) => h.icon);
  if (!imgs.length) return el('span', { class: 'muted' }, '–');
  return el('span', { class: 'holds', title: list.map((h) => h.symbol).join(', ') }, imgs.map((h) =>
    el('img', { src: h.icon, alt: h.symbol, loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() })));
}

function render(lb) {
  $('podium').replaceChildren(...lb.traders.slice(0, 3).map((t, i) => el('article', { class: `card pod pod--${i + 1}`, 'data-reveal': true },
    t.copied ? copying() : null,
    el('div', { class: 'pod__top' }, avatar(t.avatarUrl, t.handle),
      el('div', {}, el('span', { class: 'pod__rank' }, `RANK #${t.rank}`), el('div', { class: 'pod__name' }, `@${t.handle}`))),
    el('div', { class: `pod__pnl ${t.pnlUsd >= 0 ? 'up' : 'down'}` }, usd(t.pnlUsd)),
    el('div', { class: 'pod__meta' }, el('span', {}, `${vol(t.volumeUsd)} volume`), el('span', {}, `${t.trades ?? '–'} trades`)))));

  $('rows').replaceChildren(...lb.traders.slice(3).map((t) => el('tr', { class: t.copied ? 'is-copied' : null },
    el('td', {}, el('span', { class: 'rank' }, `#${t.rank}`)),
    el('td', {}, el('div', { class: 'who' }, avatar(t.avatarUrl, t.handle, 'avatar--sm'),
      el('div', {}, el('b', {}, `@${t.handle}`), el('span', {}, t.copied ? 'Copying now' : (t.solana[0] ? short(t.solana[0]) : 'No known Solana wallet'))))),
    el('td', { class: `r ${t.pnlUsd >= 0 ? 'up' : 'down'}` }, usd(t.pnlUsd)),
    el('td', { class: 'r hide-sm' }, vol(t.volumeUsd)),
    el('td', { class: 'r hide-sm' }, t.trades ?? '–'),
    el('td', { class: 'hide-sm' }, holdings(t.topHoldings)),
    el('td', { class: 'hide-sm r' }, t.solana[0] ? el('a', { class: 'linkbtn', href: `https://solscan.io/account/${t.solana[0]}`, target: '_blank', rel: 'noopener' }, 'Solscan ↗') : ''))));

  $('source').textContent = lb.syncedAt ? `Synced ${ago(Date.parse(lb.syncedAt))}` : '';
  $('copied-window').textContent = LABEL[lb.copiedWindow] ?? lb.copiedWindow;
  reveal();
}

async function load(w) {
  document.querySelectorAll('.windows button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.w === w)));
  $('podium').style.opacity = '.45';
  try { render(await api(`/api/leaderboard?window=${w}`)); }
  catch (e) { $('podium').replaceChildren(el('div', { class: 'empty', style: 'grid-column:1/-1' }, el('b', {}, 'Leaderboard unavailable'), e.message)); $('rows').replaceChildren(); }
  finally { $('podium').style.opacity = ''; }
}

document.querySelectorAll('.windows button').forEach((b) => b.addEventListener('click', () => load(b.dataset.w)));
load('24h');
