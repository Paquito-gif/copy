import { $, api, el, avatar, usd, ago, short, config, targetChip } from './common.js';

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
  $('tg-pnl').textContent = usd(pnl);
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
  if (r) $('fl-rules').textContent = `Max ${r.maxPositionPct}% per position · stop-loss at −${r.stopLossPct}%`;

  const n = coins?.length ?? 0;
  $('circuit-status').textContent = !coins || !pnl ? 'Live totals are unavailable right now. See the PnL page.' : n
    ? `${n} coin${n > 1 ? 's' : ''} launched · ${pnl.totalFeesSol.toFixed(3)} SOL in fees so far.`
    : 'No coin has launched here yet, so the wallet has no fees to copy with. The first launch starts it.';

  if (cfg.float?.split) {
    const s = cfg.float.split;
    $('split-bar').replaceChildren(...SPLIT.map(([k, , c], i) => el('i', { style: `flex:${s[k]};background:${c};animation-delay:${i * 80}ms` })));
    $('split-legend').replaceChildren(...SPLIT.map(([k, label, c]) =>
      el('li', { style: `--c:${c}`, class: k === 'creator' ? 'is-you' : null }, el('b', {}, `${s[k] / 100}%`), label)));
  }
}

target().catch(() => { $('tg-meta').textContent = 'Leaderboard unavailable right now'; });
circuit().catch((e) => console.error('circuit', e));
