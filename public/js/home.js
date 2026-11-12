import { $, api, el, avatar, usd, ago, short, config, targetChip, countUsd, tilt, flash, every, countTo, watchSeen } from './common.js';

const SPLIT = [
  ['creator', 'Public wallet (creator)', '#5b9dff'],
  ['holders', 'Coin holders', '#5fe39a'],
  ['flagship', '$FLOAT buybacks', '#ffd75e'],
  ['traders', 'Active traders', '#8b9cff'],
  ['treasury', 'Float treasury', '#4a5a80'],
];
const WINDOW = { '24h': '24h', '7d': '7-day', '30d': '30-day' };

/** The engine re-picks the leader at 00, 05, 10, 15 and 20 UTC. */
function nextCheck(now = new Date()) {
  let h = Math.floor(now.getUTCHours() / 5) * 5 + 5;
  if (h > 20) h = 24; // after 20:00 UTC the next run is midnight
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h);
  const m = Math.max(1, Math.round((next - now) / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

let live = null;

/** Keeps the trader's PnL fresh: re-reads the board every minute and flashes the change. */
async function refresh() {
  if (!live) return;
  const lb = await api('/api/leaderboard?window=24h').catch(() => null);
  const row = lb?.traders.find((x) => (live.address && x.solana.includes(live.address)) || x.handle === live.handle);
  if (!row || row.pnlUsd == null || Math.abs(row.pnlUsd - live.pnl) < 1) return;
  const node = $('tg-pnl');
  countUsd(node, row.pnlUsd, live.pnl);
  flash(node, row.pnlUsd > live.pnl);
  node.classList.toggle('up', row.pnlUsd >= 0); node.classList.toggle('down', row.pnlUsd < 0);
  live.pnl = row.pnlUsd;
}

async function target() {
  const [t, lb, cfg] = await Promise.all([api('/api/trader'), api('/api/leaderboard?window=24h').catch(() => null), config()]);
  const state = cfg.engine?.state ?? 'paused';
  const row = lb?.traders.find((x) => t.address && x.solana.includes(t.address)) ?? lb?.traders.find((x) => x.copied) ?? lb?.traders[0];
  const handle = t.label || (row ? `@${row.handle}` : null);
  if (!handle) { $('tg-meta').textContent = 'Leaderboard unavailable right now'; return; }

  $('tg-avatar').replaceWith(avatar(row?.avatarUrl, handle, 'avatar--lg'));
  $('fl-avatar').replaceWith(avatar(row?.avatarUrl, handle, 'avatar--sm'));
  $('tg-name').textContent = handle;
  $('fl-name').textContent = handle;
  $('tg-chip').replaceWith(targetChip(state));

  const win = WINDOW[t.window] ?? '24h';
  const pickedRank = t.rank ?? 1, nowRank = row?.rank;
  $('tg-meta').textContent = nowRank && nowRank !== pickedRank
    ? `Picked at #${pickedRank} · now #${nowRank} on FOMO's ${win} board`
    : `#${pickedRank} on FOMO's ${win} board${t.checkedAt ? ` · picked ${ago(t.changedAt ?? t.checkedAt)}` : ''}`;

  const pnl = row?.pnlUsd ?? t.pnlUsd;
  countUsd($('tg-pnl'), pnl);
  live = { address: t.address, handle: row?.handle, pnl };
  $('tg-pnl').className = pnl >= 0 ? 'up' : 'down';
  $('tg-window').textContent = `${win} PnL on FOMO`;
  $('tg-vol').textContent = row?.volumeUsd != null ? usd(row.volumeUsd, { sign: false }) : '–';
  $('tg-trades').textContent = row?.trades ?? '–';
  const holds = (row?.topHoldings ?? []).filter((h) => h.icon).slice(0, 3);
  if (holds.length) {
    $('tg-holds').replaceChildren(el('span', { class: 'holds', title: holds.map((h) => h.symbol).join(', ') },
      holds.map((h) => el('img', { src: h.icon, alt: h.symbol, loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() }))));
  }
  if (t.address) {
    $('tg-addr').textContent = short(t.address);
    $('tg-addr').href = `https://solscan.io/account/${t.address}`;
    $('tg-addr').setAttribute('aria-label', `${handle}'s wallet on Solscan`);
  }
  $('tg-foot').textContent = state === 'paused'
    ? `The engine is paused: nothing is being copied yet. Next leader check in ${nextCheck()}.`
    : `${state === 'simulation' ? 'Simulated copies only, no real transactions. ' : ''}Next leader check in ${nextCheck()}.`;
}

async function circuit() {
  const retry = (path) => api(path).catch(() => new Promise((r) => setTimeout(r, 1500)).then(() => api(path)));
  const [pnl, coins, cfg, quotes] = await Promise.all([
    retry('/api/pnl').catch(() => null), retry('/api/coins').catch(() => null), config(), api('/api/quotes').catch(() => []),
  ]);
  $('fl-icons').replaceChildren(...quotes.filter((q) => q.icon).slice(0, 4).map((q) => el('img', { src: q.icon, alt: '', loading: 'lazy' })));
  for (const id of ['fl-burn', 'hero-burn']) $(id).textContent = `${cfg.buybackPct}%`;
  if (cfg.float?.split) $('fl-share').textContent = `${cfg.float.split.creator / 100}%`;
  $('fl-wallet').textContent = short(cfg.feeReceiver);
  $('fl-wallet').href = `https://solscan.io/account/${cfg.feeReceiver}`;
  $('fl-balance').textContent = pnl ? `${pnl.balanceSol.toFixed(3)} SOL` : 'balance unavailable';
  $('fl-burned').textContent = pnl ? `${pnl.buybackSol.toFixed(3)} SOL` : '–';
  const r = cfg.rules;
  if (r) $('fl-rules').textContent = `Up to ${r.maxPositionPct}% of the wallet per trade, $${r.maxTradeUsd ?? 100} max · sells when the trader sells`;

  const n = coins?.length ?? 0;
  $('circuit-status').textContent = !coins || !pnl ? 'Live totals are unavailable right now. See the PnL page.' : n
    ? `${n} coin${n > 1 ? 's' : ''} launched · ${pnl.totalFeesSol.toFixed(3)} SOL in fees so far.`
    : 'No coin has launched here yet, so the wallet has no fees to copy with. The first launch starts it.';

  if (cfg.float?.split) {
    const s = cfg.float.split;
    $('split-bar').replaceChildren(...SPLIT.map(([k, , c], i) => el('i', { style: `flex:${s[k]};background:${c};animation-delay:${i * 80}ms` })));
    $('split-legend').replaceChildren(...SPLIT.map(([k, label, c]) =>
      el('li', { style: `--c:${c}`, class: k === 'creator' ? 'is-you' : null }, el('b', {}, el('span', {}, el('span', { 'data-pct': s[k] / 100 }, `${s[k] / 100}`), '%')), label)));
    // percentages count up when the split scrolls into view
    const box = document.querySelector('.split');
    const run = () => box.querySelectorAll('[data-pct]').forEach((n) => countTo(n, Number(n.dataset.pct), { decimals: 0, duration: 900 }));
    if (box.classList.contains('is-in')) run();
    else new MutationObserver((_, o) => { if (box.classList.contains('is-in')) { o.disconnect(); run(); } }).observe(box, { attributes: true, attributeFilter: ['class'] });
  }
}

// ---------- live wallet feed ----------
const ICON = {
  swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M8 7h9v9"/></svg>',
  receive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 7 7 17M16 17H7V8"/></svg>',
};
const VERB = { swap: 'Swapped', send: 'Sent', receive: 'Received' };
const amt = (n) => {
  const a = Math.abs(n);
  if (a >= 1e6) return a.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 });
  if (a >= 100) return a.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return a.toLocaleString('en-US', { maximumSignificantDigits: 4 });
};
const tokenImg = (l) => (l.icon ? el('img', { src: l.icon, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() }) : el('span', { class: 'feed__noicon' }, l.symbol.slice(0, 1)));
let seen = new Set();

function feedItem(x, fresh) {
  const legs = x.legs.map((l) => `${amt(l.amount)} ${l.symbol}`);
  const kind = el('span', { class: 'feed__kind', 'aria-hidden': 'true' }); kind.innerHTML = ICON[x.kind];
  return el('li', { class: `feed__item feed__item--${x.kind}${fresh ? ' is-new' : ''}` },
    kind,
    el('span', { class: 'feed__icons', 'aria-hidden': 'true' }, x.legs.map(tokenImg)),
    el('span', { class: 'feed__text' }, el('b', {}, VERB[x.kind]), ' ', legs.join(' → ')),
    el('span', { class: 'feed__time', 'data-t': x.t }, ago(x.t)),
    el('a', { class: 'feed__tx', href: `https://solscan.io/tx/${x.sig}`, target: '_blank', rel: 'noopener', 'aria-label': 'Transaction on Solscan' }, 'tx ↗'));
}

let feedTries = 0;
async function feed() {
  const d = await api('/api/trades');
  // the server is still reading the chain: try again shortly
  if (d.pending) { if (++feedTries <= 6) setTimeout(() => feed().catch(() => {}), 5000); return; }
  feedTries = 0;
  if (d.handle) $('feed-who').textContent = `@${d.handle}'s wallet`;
  const list = $('feed');
  if (!d.items?.length) {
    if (!seen.size) list.replaceChildren(el('li', { class: 'feed__empty' }, 'No recent activity on this wallet yet.'));
    return;
  }
  const first = !seen.size;
  const nodes = d.items.map((x, i) => {
    const n = feedItem(x, !first && !seen.has(x.sig));
    if (first) n.style.setProperty('--i', i);
    return n;
  });
  list.replaceChildren(...nodes);
  list.classList.toggle('is-first', first);
  seen = new Set(d.items.map((x) => x.sig));
}
const feedBox = document.querySelector('.feed');
every(30_000, () => document.querySelectorAll('.feed__time').forEach((n) => { n.textContent = ago(Number(n.dataset.t)); }), feedBox);

// ---------- Solana slot: real value every few seconds, ~400 ms per slot in between ----------
let base = null;
async function syncSlot() { try { base = await api('/api/slot'); } catch { /* keep counting */ } }
const feedSeen = watchSeen(feedBox);
syncSlot().then(() => {
  const n = $('slot');
  setInterval(() => { if (base && feedSeen() && document.visibilityState === 'visible') n.textContent = (base.slot + Math.max(0, Math.floor((Date.now() - base.at) / 400))).toLocaleString('en-US'); }, 400);
});
every(30_000, syncSlot, feedBox);

every(75_000, () => feed().catch(() => {}), feedBox);

const first = [target().catch(() => { $('tg-meta').textContent = 'Leaderboard unavailable right now'; }), circuit().catch((e) => console.error('circuit', e))];
// the wallet feed is the heaviest call: start it once the rest has answered
Promise.allSettled(first).then(() => feed().catch(() => { $('feed').replaceChildren(el('li', { class: 'feed__empty' }, 'The wallet feed is unavailable right now.')); }));

tilt(document.querySelectorAll('.target'), 6);
every(60_000, refresh, document.querySelector('.target'));
