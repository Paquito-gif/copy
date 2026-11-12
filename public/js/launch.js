/* global solanaWeb3 */
import { $, api, el, short, fmt, walletState, connectWallet } from './common.js';

let imageData = null, cfg = null, quotes = [], pending = null, tickerTaken = false, tickerTimer = null;

const status = (id, msg, kind = '') => { const s = $(id); s.replaceChildren(...[msg].flat()); s.className = `status ${kind}`; };
const noWallet = () => ['Aucun wallet Solana détecté. ', el('a', { href: 'https://phantom.com/download', target: '_blank', rel: 'noopener' }, 'Installer Phantom'), ', puis recharge la page.'];

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
  check('image', !!imageData, 'Ajoute une image pour ton coin.');
  check('name', $('name').value.trim().length > 0, 'Donne un nom à ton coin.');
  check('ticker', /^[A-Z0-9]{1,10}$/.test($('ticker').value), 'Ticker : 1 à 10 lettres ou chiffres.');
  check('ack', $('ack').checked, 'Coche cette case pour continuer.');
  if (tickerTaken && !errors.includes('ticker')) { setErr('ticker', `$${$('ticker').value} existe déjà sur Float. Choisis un autre ticker.`); errors.push('ticker'); }
  if (errors.length) { $(errors[0])?.focus(); $('form').classList.remove('wiggle'); void $('form').offsetWidth; $('submit').classList.add('wiggle'); setTimeout(() => $('submit').classList.remove('wiggle'), 600); }
  return !errors.length;
}

$('ticker').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  tickerTaken = false; setErr('ticker', ''); clearTimeout(tickerTimer);
  const t = e.target.value;
  if (!t) return;
  tickerTimer = setTimeout(async () => {
    try {
      const r = await api(`/api/ticker?t=${encodeURIComponent(t)}`);
      if ($('ticker').value !== t) return;
      tickerTaken = r.taken;
      setErr('ticker', r.taken ? `$${t} existe déjà sur Float. Choisis un autre ticker.` : '');
    } catch { /* revérifié au lancement */ }
  }, 450);
});
$('name').addEventListener('input', () => setErr('name', ''));
$('ack').addEventListener('change', () => setErr('ack', ''));
$('image').addEventListener('change', () => {
  const f = $('image').files[0];
  if (!f) return;
  if (f.size > 1_000_000) { setErr('image', 'Image trop lourde : 1 Mo maximum.'); return; }
  const r = new FileReader();
  r.onload = () => { imageData = r.result; $('preview').src = imageData; $('preview').hidden = false; $('image-hint').hidden = true; setErr('image', ''); };
  r.readAsDataURL(f);
});

// ---------- paires et paliers ----------
function selectPair(mint) {
  $('quote').value = mint;
  document.querySelectorAll('.pair').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mint === mint)));
}
function renderPairs(list) {
  quotes = list;
  const crypto = list.filter((q) => q.symbol === 'SOL' || q.symbol === 'USDC');
  const stocks = list.filter((q) => !crypto.includes(q));
  const chip = (q, hidden) => el('button', {
    type: 'button', class: 'pair', role: 'radio', 'aria-checked': 'false', 'data-mint': q.mint, hidden, title: q.name,
    onclick: () => selectPair(q.mint),
  }, q.icon ? el('img', { src: q.icon, alt: '', loading: 'lazy' }) : null, q.symbol);
  const LIMIT = 8;
  const stockChips = stocks.map((q, i) => chip(q, i >= LIMIT));
  const more = stocks.length > LIMIT ? el('button', { type: 'button', class: 'pairs__more', onclick: (e) => { stockChips.forEach((c) => { c.hidden = false; }); e.target.remove(); } }, `+ ${stocks.length - LIMIT} autres actions`) : null;
  $('pairs').replaceChildren(
    el('div', { class: 'pairs__group' }, el('span', { class: 'pairs__label' }, 'Crypto'), el('div', { class: 'pairs__grid' }, crypto.map((q) => chip(q)))),
    el('div', { class: 'pairs__group' }, el('span', { class: 'pairs__label' }, `Actions tokenisées · ${stocks.length}`), el('div', { class: 'pairs__grid' }, stockChips), more));
  if (list[0]) selectPair(list[0].mint);
}
function selectTier(tier) {
  $('tier').value = String(tier);
  document.querySelectorAll('#tiers button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.tier === String(tier))));
  const t = cfg?.tiers?.find((x) => x.tier === Number(tier));
  $('tier-hint').textContent = t?.per100 ? `Le wallet reçoit ≈ ${fmt(t.per100, 4)} SOL pour 100 SOL échangés sur ton coin. Un fee plus bas attire souvent plus de volume.` : '';
}

// ---------- étapes ----------
function show(view) {
  $('form').hidden = view !== 'form'; $('review').hidden = view !== 'review'; $('done').hidden = view !== 'done';
  ({ form: $('submit'), review: $('sign'), done: $('dn-raydium') })[view]?.focus({ preventScroll: true });
  $(view === 'form' ? 'form' : view).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!validate()) { status('status', 'Corrige les champs signalés.', 'err'); return; }
  const btn = $('submit'); btn.disabled = true; btn.setAttribute('aria-busy', 'true');
  try {
    if (!walletState.address && !(await connectWallet().catch(() => false))) { status('status', noWallet(), 'err'); return; }
    status('status', 'Envoi de la fiche du coin… (1/2)');
    const form = {
      name: $('name').value.trim(), ticker: $('ticker').value, description: $('description').value,
      twitter: $('twitter').value, telegram: $('telegram').value, website: $('website').value,
      quoteMint: $('quote').value, tier: Number($('tier').value),
    };
    const meta = await api('/api/metadata', { ...form, image: imageData });
    status('status', 'Simulation du lancement sur Float… (2/2)');
    const built = await api('/api/launch/build', { creator: walletState.address, name: form.name, ticker: form.ticker, uri: meta.uri, quoteMint: form.quoteMint, tier: form.tier });
    pending = { meta, built, form };
    fillReview(); status('status', ''); show('review');
  } catch (err) {
    const m = err.message || String(err);
    if (/ticker/i.test(m)) { setErr('ticker', m); $('ticker').focus(); }
    status('status', m, 'err');
  } finally { btn.disabled = false; btn.removeAttribute('aria-busy'); }
});

function fillReview() {
  const { built, form } = pending;
  const q = quotes.find((x) => x.mint === form.quoteMint);
  const t = cfg?.tiers?.find((x) => x.tier === form.tier);
  $('rv-img').src = imageData; $('rv-name').textContent = form.name; $('rv-ticker').textContent = `$${form.ticker}`;
  $('rv-pair').textContent = q ? `${q.symbol} · ${q.name}` : short(form.quoteMint);
  $('rv-tier').textContent = t ? t.label : '';
  $('rv-receiver').textContent = short(built.feeReceiver); $('rv-receiver').href = `https://solscan.io/account/${built.feeReceiver}`;
  $('rv-cost').textContent = built.costSol != null ? `≈ ${fmt(built.costSol, 4)} SOL` : 'frais réseau et création des comptes';
  $('rv-sim').textContent = `réussie · ${built.accounts} comptes`;
  status('rv-status', '');
}
$('edit').addEventListener('click', () => { pending = null; show('form'); });

$('sign').addEventListener('click', async () => {
  if (!pending) return;
  const btn = $('sign'); btn.disabled = true; btn.setAttribute('aria-busy', 'true'); $('edit').disabled = true;
  try {
    status('rv-status', 'Signe la transaction dans ton wallet.');
    const tx = solanaWeb3.VersionedTransaction.deserialize(Uint8Array.from(atob(pending.built.transaction), (c) => c.charCodeAt(0)));
    const { signature } = await walletState.provider.signAndSendTransaction(tx);
    status('rv-status', 'Transaction envoyée, confirmation sur Solana…');
    await api('/api/launch/confirm', { mint: pending.built.mint, signature, uri: pending.meta.uri });
    fillDone(signature); show('done'); confetti();
  } catch (err) {
    const m = err.message || String(err);
    if (/reject|refus|cancel|denied/i.test(m)) status('rv-status', 'Signature annulée. Rien n’a été envoyé : tu peux signer de nouveau ou modifier.', 'err');
    else { pending = null; show('form'); status('status', `${m}. Rien n'a été confirmé : relance la vérification.`, 'err'); }
  } finally { btn.disabled = false; btn.removeAttribute('aria-busy'); $('edit').disabled = false; }
});

function fillDone(signature) {
  const { built, form } = pending;
  $('dn-img').src = imageData; $('dn-name').textContent = form.name; $('dn-ticker').textContent = `$${form.ticker}`;
  $('dn-mint').textContent = built.mint;
  $('dn-raydium').href = `https://raydium.io/launchpad/token/?mint=${built.mint}`;
  $('dn-solscan').href = `https://solscan.io/tx/${signature}`;
}
$('dn-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('dn-mint').textContent); $('dn-copy').textContent = 'Adresse copiée'; }
  catch { const r = document.createRange(); r.selectNodeContents($('dn-mint')); getSelection().removeAllRanges(); getSelection().addRange(r); }
});
$('dn-again').addEventListener('click', () => {
  pending = null; imageData = null; tickerTaken = false;
  $('form').reset(); $('preview').hidden = true; $('image-hint').hidden = false;
  ['image', 'name', 'ticker', 'ack'].forEach((f) => setErr(f, ''));
  selectPair(quotes[0]?.mint); selectTier(0); $('dn-copy').textContent = 'Copier l’adresse du mint'; show('form');
});

function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#ffd23f', '#3cf29b', '#ff7a1a', '#6cc8ff', '#ff5470'];
  const box = el('div', { class: 'confetti', 'aria-hidden': 'true' });
  for (let i = 0; i < 90; i++) {
    box.append(el('i', { style: `left:${Math.random() * 100}%;background:${colors[i % colors.length]};--x:${(Math.random() - .5) * 240}px;--r:${Math.random() * 900 - 450}deg;--t:${1.6 + Math.random() * 1.6}s;animation-delay:${Math.random() * .4}s` }));
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 4000);
}

// ---------- chargement ----------
(async () => {
  try {
    cfg = await api('/api/config');
    $('receiver').textContent = cfg.feeReceiver;
    $('tiers').replaceChildren(...cfg.tiers.map((t) => el('button', { type: 'button', role: 'radio', 'aria-checked': 'false', 'data-tier': t.tier, onclick: () => selectTier(t.tier) }, t.label)));
    selectTier(0);
    if (cfg.float?.error) status('status', `Float n'accepte pas de lancement pour le moment : ${cfg.float.error}`, 'err');
    renderPairs(await api('/api/quotes'));
  } catch (e) { status('status', e.message, 'err'); }
})();
