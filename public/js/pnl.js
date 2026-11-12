import { $, api, el, fmt, sol, signed, short, ago, countTo, reveal } from './common.js';

const KIND = { buy: 'Copy buy', sell: 'Sell', buyback: 'Buyback', burn: 'Burn', convert: 'Fees → SOL' };
const tone = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');

function chart(series) {
  const box = $('chart');
  if (!series.length) {
    box.replaceChildren(el('div', { class: 'empty' }, el('b', {}, 'No closed trades yet'), 'The curve draws itself after the wallet’s first sell.'));
    return;
  }
  const W = 600, H = 230, P = 28;
  const pts = [{ t: series[0].t, pnl: 0 }, ...series];
  const xs = pts.map((_, i) => P + (i / (pts.length - 1)) * (W - 2 * P));
  const vals = pts.map((p) => p.pnl);
  const min = Math.min(0, ...vals), max = Math.max(0, ...vals);
  const y = (v) => H - P - ((v - min) / (max - min || 1)) * (H - 2 * P);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${xs[i].toFixed(1)},${y(p.pnl).toFixed(1)}`).join(' ');
  const last = vals[vals.length - 1];
  const color = last >= 0 ? '#5fe39a' : '#ff6b4a';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Cumulative realized PnL: ${signed(last)} SOL over ${series.length} trades`);
  const date = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  svg.innerHTML = `<defs><linearGradient id="pnlfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".28"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <line class="zero" x1="${P}" x2="${W - P}" y1="${y(0)}" y2="${y(0)}"/>
    <path class="area" fill="url(#pnlfill)" d="${d} L${xs[xs.length - 1]},${y(0)} L${xs[0]},${y(0)} Z"/>
    <path class="line ${last < 0 ? 'is-down' : ''}" d="${d}"/>
    <circle cx="${xs[xs.length - 1]}" cy="${y(last)}" r="4.5" fill="${color}"/>
    <text x="${P}" y="${H - 6}">${date(pts[0].t)}</text>
    <text x="${W - P}" y="${H - 6}" text-anchor="end">${date(pts[pts.length - 1].t)}</text>
    <text x="${W - P}" y="${Math.max(14, y(last) - 12)}" text-anchor="end">${signed(last)} SOL</text>`;
  box.replaceChildren(svg);
  const line = svg.querySelector('.line');
  line.style.setProperty('--len', String(Math.ceil(line.getTotalLength())));
}

function list(id, items, emptyText) {
  $(id).replaceChildren(...(items.length ? items : [el('div', { class: 'empty', style: 'min-height:120px' }, emptyText)]));
}

async function load() {
  const p = await api('/api/pnl');
  const total = p.realizedPnlSol + p.unrealizedPnlSol;

  if (!p.running || p.dryRun) {
    const b = $('banner');
    b.hidden = false;
    b.replaceChildren(el('span', { class: `live ${p.running ? '' : 'live--off'}`, 'aria-hidden': 'true' }),
      el('span', {}, el('b', {}, p.running ? 'Engine in simulation. ' : 'Engine paused. '),
        p.running ? 'Trades are simulated; no real transaction is sent.' : 'The wallet isn’t copying trades yet. These numbers fill in once it starts.'));
  }

  countTo($('pnl-total'), total, { signedValue: true });
  $('pnl-total').className = `big__num ${tone(total)}`;
  $('pnl-usd').textContent = p.solUsd ? `SOL · ≈ ${total < 0 ? '−' : total > 0 ? '+' : ''}$${Math.abs(total * p.solUsd).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : 'SOL';
  $('pnl-real').textContent = `${signed(p.realizedPnlSol)} SOL`; $('pnl-real').className = tone(p.realizedPnlSol);
  $('pnl-unreal').textContent = `${signed(p.unrealizedPnlSol)} SOL`; $('pnl-unreal').className = tone(p.unrealizedPnlSol);
  $('pnl-trades').textContent = String(p.trades.closed);
  $('pnl-win').textContent = p.trades.winRate == null ? '–' : `${Math.round(p.trades.winRate * 100)}%`;

  countTo($('st-bal'), p.balanceSol);
  countTo($('st-fees'), p.totalFeesSol);
  countTo($('st-burn'), p.buybackSol);
  countTo($('st-bucket'), p.buybackBucketSol);
  chart(p.series);

  list('positions', p.positions.map((x) => el('div', { class: 'item' },
    el('span', {}, el('a', { href: `https://solscan.io/token/${x.mint}`, target: '_blank', rel: 'noopener' }, short(x.mint)),
      el('span', { class: 'muted', style: 'margin-left:8px;font-size:12px' }, `opened ${ago(x.openedAt)}`)),
    el('span', { class: `num ${tone(x.pnlSol ?? 0)}` }, x.pnlSol == null ? `${fmt(x.costSol)} SOL in` : `${signed(x.pnlSol)} SOL`))),
  'No open positions.');

  list('history', p.history.map((e) => {
    const d = e.detail || {};
    const extra = d.pnl != null ? el('span', { class: `num ${tone(d.pnl)}` }, `${signed(d.pnl, 4)} SOL`)
      : d.sol ? el('span', { class: 'num' }, sol(d.sol, 4)) : d.ticker ? el('span', {}, `$${d.ticker}`) : null;
    return el('div', { class: 'item' },
      el('span', {}, el('span', { class: `kind kind--${e.kind}` }, KIND[e.kind] ?? e.kind), el('span', { class: 'muted', style: 'font-size:12px' }, ago(e.t))),
      el('span', { style: 'display:flex;gap:10px;align-items:center' }, extra,
        d.sig ? el('a', { href: `https://solscan.io/tx/${d.sig}`, target: '_blank', rel: 'noopener' }, 'tx ↗') : null));
  }), 'Copied trades, buybacks and burns will show up here with their transaction.');

  $('coins').replaceChildren(...(p.coins.length
    ? p.coins.map((c) => el('a', { class: 'card coin', href: `https://solscan.io/token/${c.mint}`, target: '_blank', rel: 'noopener', 'data-reveal': true },
      el('img', { src: c.image, alt: '', loading: 'lazy' }),
      el('b', {}, `$${c.ticker}`),
      el('small', {}, `${fmt(c.stats?.feesSol ?? 0, 4)} SOL in fees`),
      el('small', {}, `${fmt(c.stats?.buybackSol ?? 0, 4)} SOL bought back`)))
    : [el('div', { class: 'empty', style: 'grid-column:1/-1' }, el('b', {}, 'No coins launched yet'), el('a', { class: 'btn btn--sm', href: '/launch', style: 'margin-top:8px' }, 'Launch the first one'))]));

  $('wallet-link').textContent = p.wallet;
  $('wallet-link').href = `https://solscan.io/account/${p.wallet}`;
  reveal();
}

load().catch((e) => { $('banner').hidden = false; $('banner').textContent = `Data unavailable: ${e.message}`; });
