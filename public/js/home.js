import { $, api, el, avatar, usd, ago, countTo, short } from './common.js';

const SPLIT = [
  ['creator', 'Wallet public (créateur)', '#516af6'],
  ['holders', 'Holders du coin', '#2fe27e'],
  ['flagship', 'Rachat de $FLOAT', '#ffe02a'],
  ['traders', 'Traders actifs', '#3d8bff'],
  ['treasury', 'Trésorerie Float', '#4a5680'],
];

async function copycard() {
  const [t, lb] = await Promise.all([api('/api/trader'), api('/api/leaderboard?window=24h').catch(() => null)]);
  const row = lb?.traders.find((x) => x.copied) ?? lb?.traders[0];
  const name = t.label || (row ? `@${row.handle}` : null);
  if (!name) { $('cc-name').textContent = 'Classement indisponible'; return; }
  $('cc-who').firstElementChild.replaceWith(avatar(row?.avatarUrl, name));
  $('cc-name').textContent = name;
  const pnl = row?.pnlUsd ?? t.pnlUsd;
  $('cc-pnl').textContent = usd(pnl);
  $('cc-pnl').className = `copycard__pnl mono ${pnl >= 0 ? 'up' : 'down'}`;
  $('cc-window').textContent = `PnL sur ${t.window || '24h'}, selon FOMO${t.rank ? ` · n°${t.rank}` : ''}`;
  $('cc-last').textContent = t.lastActiveAt ? ago(t.lastActiveAt) : '–';
  $('cc-tx').textContent = t.recentTx ? String(t.recentTx) : '–';
}

async function floaters() {
  const box = $('floaters');
  try {
    const quotes = (await api('/api/quotes')).filter((q) => q.icon).slice(0, 9);
    const spots = [[6, 8], [78, 4], [88, 46], [2, 58], [70, 82], [20, 86], [45, 0], [92, 22], [30, 30]];
    quotes.forEach((q, i) => {
      const [x, y] = spots[i % spots.length];
      box.append(el('img', {
        class: 'floater', src: q.icon, alt: '', loading: 'lazy',
        style: `left:${x}%;top:${y}%;--s:${44 + (i % 3) * 14}px;--d:${5 + (i % 4)}s;--delay:-${i * 0.7}s`,
      }));
    });
  } catch { /* décor seulement */ }
}

async function numbers() {
  const [pnl, coins, cfg] = await Promise.all([api('/api/pnl'), api('/api/coins'), api('/api/config')]);
  countTo($('st-fees'), pnl.totalFeesSol);
  countTo($('st-pnl'), pnl.realizedPnlSol, { signedValue: true });
  countTo($('st-burn'), pnl.buybackSol);
  countTo($('st-coins'), coins.length, { decimals: 0 });
  $('st-engine').textContent = pnl.running ? (pnl.dryRun ? 'moteur en simulation' : 'moteur actif') : 'moteur en pause';
  $('bb-pct').textContent = `${cfg.buybackPct} %`;
  if (cfg.float?.split) {
    const s = cfg.float.split;
    $('split-bar').replaceChildren(...SPLIT.map(([k, , c], i) => el('i', { style: `flex:${s[k]};background:${c};animation-delay:${i * 90}ms` })));
    $('split-legend').replaceChildren(...SPLIT.map(([k, label, c]) =>
      el('li', { style: `--c:${c}`, class: k === 'creator' ? 'is-you' : null }, el('b', {}, `${s[k] / 100} %`), label)));
  }
}

copycard().catch(() => { $('cc-name').textContent = 'Classement indisponible'; });
floaters();
numbers().catch(() => {});
