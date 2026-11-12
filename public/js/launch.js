/* global solanaWeb3 */
import { $, api, el, fmt, walletState, connectWallet, config } from './common.js';

let imageData = null, cfg = null, quotes = [], pending = null, tickerTaken = false, tickerTimer = null, filter = 'all';
const isCrypto = (q) => q.symbol === 'SOL' || q.symbol === 'USDC';

const status = (msg, kind = '') => { const s = $('status'); s.replaceChildren(...[msg].flat()); s.className = `status ${kind}`; };
const noWallet = () => ['No Solana wallet found. ', el('a', { href: 'https://phantom.com/download', target: '_blank', rel: 'noopener' }, 'Get Phantom'), ', then reload the page.'];

// ---------- live preview ----------
function preview() {
  const t = $('ticker').value;
  $('pv-ticker').textContent = t ? `$${t}` : '$TICKER';
  $('pv-name').textContent = $('name').value.trim() || 'Your coin';
  const q = quotes.find((x) => x.mint === $('quote').value);
  $('pv-pair').textContent = q ? q.symbol : '–';
  const tier = cfg?.tiers?.find((x) => String(x.tier) === $('tier').value);
  $('pv-tier').textContent = tier?.label?.replace(/\s/g, '').replace(',', '.') ?? '–';
  $('mb-ticker').textContent = $('pv-ticker').textContent;
  $('mb-meta').textContent = `${q ? q.symbol : '–'} pair · ${$('pv-tier').textContent} fee`;
}

// ---------- validation ----------
function setErr(field, msg) {
  const err = $(`err-${field}`);
  if (err) err.textContent = msg || '';
  if (field === 'image') $('image-pick').toggleAttribute('data-invalid', !!msg);
  else $(field)?.setAttribute('aria-invalid', msg ? 'true' : 'false');
}
function validate() {
  const errors = [];
  const check = (f, ok, msg) => { setErr(f, ok ? '' : msg); if (!ok) errors.push(f); };
  check('ticker', /^[A-Z0-9]{1,10}$/.test($('ticker').value), 'Ticker: 1 to 10 letters or digits.');
  check('name', $('name').value.trim().length > 0, 'Give your coin a name.');
  check('image', !!imageData, 'Add an image for your coin.');
  check('ack', $('ack').checked, 'Check this box to continue.');
  if (tickerTaken && !errors.includes('ticker')) { setErr('ticker', `$${$('ticker').value} already exists on Float. Pick another ticker.`); errors.push('ticker'); }
  if (errors.length) {
    $(errors[0])?.focus();
    $('submit').classList.remove('shake'); void $('submit').offsetWidth; $('submit').classList.add('shake');
  }
  return !errors.length;
}

$('ticker').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  preview();
  tickerTaken = false; setErr('ticker', ''); clearTimeout(tickerTimer);
  const t = e.target.value;
  if (!t) return;
  tickerTimer = setTimeout(async () => {
    try {
      const r = await api(`/api/ticker?t=${encodeURIComponent(t)}`);
      if ($('ticker').value !== t) return;
      tickerTaken = r.taken;
      setErr('ticker', r.taken ? `$${t} already exists on Float. Pick another ticker.` : '');
    } catch { /* checked again on launch */ }
  }, 450);
});
$('name').addEventListener('input', () => { setErr('name', ''); preview(); });
$('ack').addEventListener('change', () => setErr('ack', ''));
$('image').addEventListener('change', () => {
  const f = $('image').files[0];
  if (!f) return;
  if (f.size > 1_000_000) { setErr('image', 'Image too large: 1 MB max.'); return; }
  const r = new FileReader();
  r.onload = () => {
    imageData = r.result;
    $('thumb').replaceChildren(el('img', { src: imageData, alt: '' }));
    $('pv-img').replaceChildren(el('img', { src: imageData, alt: '' }));
    setErr('image', '');
  };
  r.readAsDataURL(f);
});

// ---------- pairs & fee tiers ----------
function selectPair(mint) {
  $('quote').value = mint;
  document.querySelectorAll('.pair').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mint === mint)));
  preview();
}
function renderPairs() {
  const term = $('pair-search').value.trim().toLowerCase();
  const list = quotes.filter((q) => (filter === 'all' || (filter === 'crypto') === isCrypto(q))
    && (!term || q.symbol.toLowerCase().includes(term) || q.name.toLowerCase().includes(term)));
  $('pairs').replaceChildren(...(list.length ? list.map((q) => el('button', {
    type: 'button', class: 'pair', role: 'radio', 'aria-checked': String(q.mint === $('quote').value), 'data-mint': q.mint,
    onclick: () => selectPair(q.mint),
  }, q.icon ? el('img', { src: q.icon, alt: '', loading: 'lazy' }) : null,
  el('span', {}, el('b', {}, q.symbol), el('em', {}, isCrypto(q) ? 'Crypto' : 'xStock'), el('small', {}, q.name))))
    : [el('p', { class: 'hint' }, 'No pair matches your search.')]));
}
$('pair-search').addEventListener('input', renderPairs);
document.querySelectorAll('.filters button').forEach((b) => b.addEventListener('click', () => {
  filter = b.dataset.f;
  document.querySelectorAll('.filters button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderPairs();
}));

function selectTier(tier) {
  $('tier').value = String(tier);
  document.querySelectorAll('#tiers button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.tier === String(tier))));
  const t = cfg?.tiers?.find((x) => x.tier === Number(tier));
  $('tier-hint').textContent = t?.per100 ? `The public wallet earns ≈ ${fmt(t.per100, 4)} SOL for every 100 SOL traded on your coin.` : '';
  preview();
}

// ---------- flow: form → review → sign → done ----------
function stage(name) {
  $('step-form').hidden = name !== 'form';
  $('step-sign').hidden = name !== 'sign';
  $('step-done').hidden = name !== 'done';
  $('pv-cost-row').hidden = name === 'form';
  $('pv-sim-row').hidden = name === 'form';
  for (const n of $('form').querySelectorAll('input, textarea, button')) n.disabled = name !== 'form';
  ({ sign: $('sign'), done: $('dn-raydium') })[name]?.focus({ preventScroll: true });
  if (name !== 'form') document.querySelector('.review-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  mobileBar();
}

// ---------- mobile: keep the summary and the button in reach ----------
let reviewVisible = false;
const mobileBar = () => {
  const wide = matchMedia('(min-width: 941px)').matches;
  $('mbar').hidden = wide || reviewVisible || $('step-form').hidden;
};
new IntersectionObserver(([e]) => { reviewVisible = e.isIntersecting; mobileBar(); }).observe(document.querySelector('.review-card'));
matchMedia('(min-width: 941px)').addEventListener('change', mobileBar);

$('pv-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(cfg.feeReceiver); $('pv-copy').textContent = 'Copied'; setTimeout(() => { $('pv-copy').textContent = 'Copy address'; }, 1800); }
  catch { const r = document.createRange(); r.selectNodeContents($('pv-receiver')); getSelection().removeAllRanges(); getSelection().addRange(r); }
});

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!validate()) { status('Some fields need attention: the first one is selected above.', 'err'); return; }
  const btn = $('submit'); btn.disabled = true; btn.setAttribute('aria-busy', 'true');
  try {
    if (!walletState.address && !(await connectWallet().catch(() => false))) { status(noWallet(), 'err'); return; }
    status('Uploading coin metadata… (1/2)');
    const form = {
      name: $('name').value.trim(), ticker: $('ticker').value, description: $('description').value,
      twitter: $('twitter').value, telegram: $('telegram').value, website: $('website').value,
      quoteMint: $('quote').value, tier: Number($('tier').value),
    };
    const meta = await api('/api/metadata', { ...form, image: imageData });
    status('Simulating the launch on Float… (2/2)');
    const built = await api('/api/launch/build', { creator: walletState.address, name: form.name, ticker: form.ticker, uri: meta.uri, quoteMint: form.quoteMint, tier: form.tier });
    pending = { meta, built, form };
    $('pv-cost').textContent = built.costSol != null ? `≈ ${fmt(built.costSol, 4)} SOL` : 'network fees + account rent';
    $('pv-sim').textContent = `Passed · ${built.accounts} accounts`;
    status('');
    stage('sign');
  } catch (err) {
    const m = err.message || String(err);
    if (/ticker/i.test(m)) { setErr('ticker', m); $('ticker').focus(); }
    status(m, 'err');
  } finally { btn.disabled = false; btn.removeAttribute('aria-busy'); }
});

$('edit').addEventListener('click', () => { pending = null; status(''); stage('form'); });

$('sign').addEventListener('click', async () => {
  if (!pending) return;
  const btn = $('sign'); btn.disabled = true; btn.setAttribute('aria-busy', 'true'); $('edit').disabled = true;
  try {
    status('Approve the transaction in your wallet.');
    const tx = solanaWeb3.VersionedTransaction.deserialize(Uint8Array.from(atob(pending.built.transaction), (c) => c.charCodeAt(0)));
    const { signature } = await walletState.provider.signAndSendTransaction(tx);
    status('Sent. Confirming on Solana…');
    await api('/api/launch/confirm', { mint: pending.built.mint, signature, uri: pending.meta.uri });
    $('dn-mint').textContent = pending.built.mint;
    $('dn-raydium').href = `https://raydium.io/launchpad/token/?mint=${pending.built.mint}`;
    $('dn-solscan').href = `https://solscan.io/tx/${signature}`;
    status('');
    stage('done');
    confetti();
  } catch (err) {
    const m = err.message || String(err);
    if (/reject|declin|cancel|denied/i.test(m)) status('Signature cancelled. Nothing was sent: sign again or edit.', 'err');
    else { pending = null; stage('form'); status(`${m}. Nothing was confirmed: review the launch again.`, 'err'); }
  } finally { btn.disabled = false; btn.removeAttribute('aria-busy'); $('edit').disabled = false; }
});

$('dn-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('dn-mint').textContent); $('dn-copy').textContent = 'Copied'; }
  catch { const r = document.createRange(); r.selectNodeContents($('dn-mint')); getSelection().removeAllRanges(); getSelection().addRange(r); }
});
$('dn-again').addEventListener('click', () => {
  pending = null; imageData = null; tickerTaken = false;
  stage('form');
  $('form').reset();
  $('thumb').replaceChildren(el('span', { class: 'hint' }, '+'));
  $('pv-img').replaceChildren('?');
  ['image', 'name', 'ticker', 'ack'].forEach((f) => setErr(f, ''));
  selectPair(quotes[0]?.mint); selectTier(0); $('dn-copy').textContent = 'Copy mint address';
});

function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#3d8bff', '#5b9dff', '#516af6', '#5fe39a', '#e9eefa'];
  const box = el('div', { class: 'confetti', 'aria-hidden': 'true' });
  for (let i = 0; i < 80; i++) {
    box.append(el('i', { style: `left:${Math.random() * 100}%;background:${colors[i % colors.length]};--x:${(Math.random() - .5) * 220}px;--r:${Math.random() * 900 - 450}deg;--t:${1.6 + Math.random() * 1.4}s;animation-delay:${Math.random() * .3}s` }));
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 3600);
}

// ---------- load ----------
(async () => {
  try {
    cfg = await config();
    $('pv-receiver').textContent = cfg.feeReceiver;
    $('pv-solscan').href = `https://solscan.io/account/${cfg.feeReceiver}`;
    $('tiers').replaceChildren(...cfg.tiers.map((t) => el('button', { type: 'button', role: 'radio', 'aria-checked': 'false', 'data-tier': t.tier, onclick: () => selectTier(t.tier) }, t.label.replace(/\s/g, '').replace(',', '.'))));
    selectTier(0);
    if (cfg.float?.error) status(`Float isn't accepting launches right now: ${cfg.float.error}`, 'err');
    quotes = await api('/api/quotes');
    $('quote').value = quotes[0]?.mint ?? '';
    renderPairs();
    preview();
  } catch (e) { status(e.message, 'err'); }
})();
