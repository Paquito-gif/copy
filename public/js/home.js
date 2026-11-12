import { $, api, el, avatar, usd, ago, countTo } from './common.js';

const SPLIT = [
  ['creator', 'Public wallet (creator)', '#3d8bff'],
  ['holders', 'Coin holders', '#5fe39a'],
  ['flagship', '$FLOAT buybacks', '#ffd75e'],
  ['traders', 'Active traders', '#516af6'],
  ['treasury', 'Float treasury', '#3a4a6e'],
];
const WINDOW = { '24h': '24h', '7d': '7-day', '30d': '30-day' };

async function copybar() {
  const [t, lb] = await Promise.all([api('/api/trader'), api('/api/leaderboard?window=24h').catch(() => null)]);
  const row = lb?.traders.find((x) => x.copied) ?? lb?.traders[0];
  const name = t.label || (row ? `@${row.handle}` : null);
  if (!name) { $('cc-name').textContent = 'Leaderboard unavailable'; return; }
  $('cc-avatar').replaceWith(avatar(row?.avatarUrl, name, 'avatar--lg'));
  $('cc-name').textContent = name;
  $('cc-rank').textContent = `FOMO #${t.rank ?? row?.rank ?? 1}`;
  const pnl = row?.pnlUsd ?? t.pnlUsd;
  $('cc-pnl').textContent = usd(pnl);
  $('cc-pnl').className = pnl >= 0 ? 'up' : 'down';
  $('cc-window').textContent = `${WINDOW[t.window] ?? '24h'} PnL`;
  $('cc-last').textContent = t.lastActiveAt ? ago(t.lastActiveAt) : '–';
  $('cc-tx').textContent = t.recentTx ? String(t.recentTx) : '–';
  $('cc-state').textContent = t.running ? 'Copying live' : 'Engine paused';
}

async function numbers() {
  const [pnl, coins, cfg] = await Promise.all([api('/api/pnl'), api('/api/coins'), api('/api/config')]);
  countTo($('st-fees'), pnl.totalFeesSol);
  countTo($('st-pnl'), pnl.realizedPnlSol, { signedValue: true });
  countTo($('st-burn'), pnl.buybackSol);
  countTo($('st-coins'), coins.length, { decimals: 0 });
  $('st-engine').textContent = pnl.running ? (pnl.dryRun ? 'engine in simulation' : 'engine live') : 'engine paused';
  $('bb-pct').textContent = `${cfg.buybackPct}%`;
  if (cfg.float?.split) {
    const s = cfg.float.split;
    $('split-bar').replaceChildren(...SPLIT.map(([k, , c], i) => el('i', { style: `flex:${s[k]};background:${c};animation-delay:${i * 80}ms` })));
    $('split-legend').replaceChildren(...SPLIT.map(([k, label, c]) =>
      el('li', { style: `--c:${c}`, class: k === 'creator' ? 'is-you' : null }, el('b', {}, `${s[k] / 100}%`), label)));
  }
}

copybar().catch(() => { $('cc-name').textContent = 'Leaderboard unavailable'; });
numbers().catch(() => {});
