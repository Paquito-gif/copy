import { $, api, el, avatar, usd, ago, short, reveal, engineState, targetChip, countUsd, tilt, flash, every, buildCoins } from './common.js';

const LABEL = { '24h': '24h', '7d': '7-day', '30d': '30-day' };
const vol = (n) => (n == null ? '–' : usd(n, { sign: false }));
let state = 'paused', cur = '24h', prev = new Map(), synced = null;

function holdings(list) {
  const imgs = (list ?? []).filter((h) => h.icon);
  if (!imgs.length) return el('span', { class: 'muted' }, '–');
  return el('span', { class: 'holds', title: list.map((h) => h.symbol).join(', ') }, imgs.map((h) =>
    el('img', { src: h.icon, alt: h.symbol, loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() })));
}

function render(lb, quiet = false) {
  const MEDAL = ['gold', 'silver', 'bronze'];
  $('podium').replaceChildren(...lb.traders.slice(0, 3).map((t, i) => el('article', { class: `card card--ticks pod pod--${i + 1}`, 'data-reveal': true },
    el('div', { class: `coin3d coin3d--medal coin3d--${MEDAL[i]}`, 'data-face': 'text', 'data-text': String(t.rank), 'aria-hidden': 'true' }),
    t.copied ? targetChip(state) : null,
    el('div', { class: 'pod__top' }, avatar(t.avatarUrl, t.handle),
      el('div', {}, el('span', { class: 'pod__rank' }, `RANK #${t.rank}`), el('div', { class: 'pod__name' }, `@${t.handle}`))),
    el('div', { class: `pod__pnl ${t.pnlUsd >= 0 ? 'up' : 'down'}` }, usd(t.pnlUsd)),
    el('div', { class: 'pod__meta' },
      t.volumeUsd != null ? el('span', {}, `${vol(t.volumeUsd)} volume`) : null,
      t.trades != null ? el('span', {}, `${t.trades} trades`) : null,
      t.solana[0] ? el('a', { class: 'linkbtn', href: `https://solscan.io/account/${t.solana[0]}`, target: '_blank', rel: 'noopener' }, 'Solscan ↗')
        : el('span', { title: 'FOMO does not list a Solana wallet for this trader, so it cannot be copied.' }, 'Wallet not public')))));

  $('rows').replaceChildren(...lb.traders.slice(3).map((t) => el('tr', { class: t.copied ? 'is-copied' : null, 'data-reveal': true },
    el('td', {}, el('span', { class: 'rank' }, `#${t.rank}`)),
    el('td', {}, el('div', { class: 'who' }, avatar(t.avatarUrl, t.handle, 'avatar--sm'),
      el('div', {}, el('b', {}, `@${t.handle}`), t.solana[0]
        ? el('a', { class: 'who__addr', href: `https://solscan.io/account/${t.solana[0]}`, target: '_blank', rel: 'noopener' }, short(t.solana[0]))
        : el('span', { title: 'FOMO does not list a Solana wallet for this trader, so it cannot be copied.' }, 'Wallet not public'),
        t.copied ? targetChip(state, true) : null))),
    el('td', { class: `r ${t.pnlUsd >= 0 ? 'up' : 'down'}`, 'data-h': t.handle }, usd(t.pnlUsd)),
    el('td', { class: 'r hide-sm' }, vol(t.volumeUsd)),
    el('td', { class: 'r hide-sm' }, t.trades ?? '–'),
    el('td', { class: 'hide-sm' }, holdings(t.topHoldings)),
    el('td', { class: 'hide-sm r' }, t.solana[0] ? el('a', { class: 'linkbtn', href: `https://solscan.io/account/${t.solana[0]}`, target: '_blank', rel: 'noopener', 'aria-label': `@${t.handle} on Solscan` }, 'Solscan ↗') : ''))));

  synced = lb.syncedAt ? Date.parse(lb.syncedAt) : null;
  $('source').textContent = synced ? `Synced ${ago(synced)}` : '';
  $('copied-window').textContent = LABEL[lb.copiedWindow] ?? lb.copiedWindow;
  document.querySelectorAll('.pod__pnl').forEach((n, i) => {
    const t = lb.traders[i], before = prev.get(t.handle);
    if (!quiet) countUsd(n, t.pnlUsd);
    else if (before != null && Math.abs(before - t.pnlUsd) >= 1) { countUsd(n, t.pnlUsd, before); flash(n, t.pnlUsd > before); }
    else n.textContent = usd(t.pnlUsd);
  });
  if (quiet) {
    document.querySelectorAll('[data-h]').forEach((n) => {
      const before = prev.get(n.dataset.h), now = lb.traders.find((t) => t.handle === n.dataset.h)?.pnlUsd;
      if (before != null && now != null && Math.abs(before - now) >= 1) flash(n, now > before);
    });
    document.querySelectorAll('[data-reveal]').forEach((n) => n.classList.add('is-in'));
  }
  prev = new Map(lb.traders.map((t) => [t.handle, t.pnlUsd]));
  buildCoins($('podium'));
  tilt(document.querySelectorAll('.pod'), 5);
  reveal();
}

async function load(w) {
  cur = w; prev = new Map();
  document.querySelectorAll('.windows button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.w === w)));
  $('podium').style.opacity = '.45';
  try { render(await api(`/api/leaderboard?window=${w}`)); }
  catch (e) { $('podium').replaceChildren(el('div', { class: 'empty', style: 'grid-column:1/-1' }, el('b', {}, 'Leaderboard unavailable'), e.message)); $('rows').replaceChildren(); }
  finally { $('podium').style.opacity = ''; }
}

document.querySelectorAll('.windows button').forEach((b) => b.addEventListener('click', () => load(b.dataset.w)));
engineState().then((s) => { state = s; }).finally(() => load('24h'));
every(60_000, async () => { try { render(await api(`/api/leaderboard?window=${cur}`), true); } catch { /* keep the last board */ } });
every(20_000, () => { if (synced) $('source').textContent = `Synced ${ago(synced)}`; });
