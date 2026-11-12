import { $, api, el, avatar, usd, ago, countTo } from './common.js';

const SPLIT = [
  ['creator', 'Public wallet (creator)', '#3d8bff'],
  ['holders', 'Coin holders', '#5fe39a'],
  ['flagship', '$FLOAT buybacks', '#ffd75e'],
  ['traders', 'Active traders', '#516af6'],
  ['treasury', 'Float treasury', '#3a4a6e'],
];
const WINDOW = { '24h': '24h', '7d': '7-day', '30d': '30-day' };

async function flow() {
  const [t, lb, quotes] = await Promise.all([api('/api/trader'), api('/api/leaderboard?window=24h').catch(() => null), api('/api/quotes').catch(() => [])]);
  const icons = quotes.filter((q) => q.icon).slice(0, 4);
  $('fl-icons').replaceChildren(...icons.map((q) => el('img', { src: q.icon, alt: '', loading: 'lazy' })));
  const row = lb?.traders.find((x) => x.copied) ?? lb?.traders[0];
  const name = t.label || (row ? `@${row.handle}` : null);
  if (!name) { $('fl-meta').textContent = 'Leaderboard unavailable'; return; }
  $('fl-avatar').replaceWith(avatar(row?.avatarUrl, name, 'avatar--sm'));
  $('fl-name').textContent = name;
  const pnl = row?.pnlUsd ?? t.pnlUsd;
  $('fl-pnl').textContent = usd(pnl);
  $('fl-pnl').className = `flow__value ${pnl >= 0 ? 'up' : 'down'}`;
  $('fl-meta').textContent = `FOMO #${t.rank ?? row?.rank ?? 1} · ${WINDOW[t.window] ?? '24h'} PnL${t.lastActiveAt ? ` · traded ${ago(t.lastActiveAt)}` : ''}`;
}

async function numbers() {
  const [pnl, coins, cfg] = await Promise.all([api('/api/pnl'), api('/api/coins'), api('/api/config')]);
  countTo($('st-fees'), pnl.totalFeesSol);
  countTo($('st-pnl'), pnl.realizedPnlSol, { signedValue: true });
  countTo($('st-burn'), pnl.buybackSol);
  countTo($('st-coins'), coins.length, { decimals: 0 });
  $('st-engine').textContent = pnl.running ? (pnl.dryRun ? 'engine in simulation' : 'engine live') : 'engine paused';
  $('bb-pct').textContent = `${cfg.buybackPct}%`;
  for (const id of ['f-burn', 'fl-burn']) $(id).textContent = `${cfg.buybackPct}%`;
  const share = cfg.float?.split ? `${cfg.float.split.creator / 100}%` : '5%';
  for (const id of ['f-share', 'fl-share']) $(id).textContent = share;
  $('fl-wallet').textContent = `${cfg.feeReceiver.slice(0, 4)}…${cfg.feeReceiver.slice(-4)}`;
  $('fl-balance').textContent = `${pnl.balanceSol.toFixed(3)} SOL`;
  $('fl-burned').textContent = `${pnl.buybackSol.toFixed(3)} SOL`;
  if (cfg.float?.split) {
    const s = cfg.float.split;
    $('split-bar').replaceChildren(...SPLIT.map(([k, , c], i) => el('i', { style: `flex:${s[k]};background:${c};animation-delay:${i * 80}ms` })));
    $('split-legend').replaceChildren(...SPLIT.map(([k, label, c]) =>
      el('li', { style: `--c:${c}`, class: k === 'creator' ? 'is-you' : null }, el('b', {}, `${s[k] / 100}%`), label)));
  }
}

flow().catch(() => { $('fl-meta').textContent = 'Leaderboard unavailable'; });
numbers().catch(() => {});
