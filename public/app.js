/* global solanaWeb3 */
const $ = (id) => document.getElementById(id);
const fmt = (n, d = 3) => Number(n || 0).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
const sol = (n) => `${fmt(n)} SOL`;
const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '–');
const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'à l’instant';
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `il y a ${h} h` : `il y a ${Math.round(h / 24)} j`;
};

let provider = null;
let wallet = null;
let imageData = null;
let cfg = null;
let quotes = [];
let pending = null; // { meta, built, form }

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k === 'style') e.style.cssText = v; else if (v != null) e.setAttribute(k, v);
  }
  for (const c of children) if (c != null && c !== '') e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

function status(target, msg, kind = '') {
  const s = $(target);
  s.replaceChildren(...(Array.isArray(msg) ? msg : [msg]));
  s.className = `launch__status ${kind}`;
}

async function api(path, body) {
  const r = await fetch(path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Erreur ${r.status}`);
  return data;
}

// ---------- Wallet ----------
function findProvider() {
  if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
  if (window.solflare?.isSolflare) return window.solflare;
  if (window.backpack?.isBackpack) return window.backpack;
  return window.solana || null;
}

const noWalletMsg = () => ['Aucun wallet Solana détecté. ',
  el('a', { href: 'https://phantom.com/download', target: '_blank', rel: 'noopener' }, 'Installer Phantom'),
  ', puis recharge la page.'];

async function connect() {
  provider = findProvider();
  if (!provider) return false;
  const res = await provider.connect();
  wallet = (res?.publicKey || provider.publicKey).toString();
  $('connect').textContent = short(wallet);
  return true;
}
$('connect').addEventListener('click', async () => {
  try {
    if (!(await connect())) {
      $('connect').textContent = 'Installer Phantom';
      window.open('https://phantom.com/download', '_blank', 'noopener');
    }
  } catch {
    $('connect').textContent = 'Connexion refusée';
    setTimeout(() => { $('connect').textContent = 'Connecter le wallet'; }, 2500);
  }
});

// ---------- Validation ----------
let tickerTaken = false;
let tickerTimer = null;

function setErr(field, msg) {
  const err = $(`err-${field}`);
  if (err) err.textContent = msg || '';
  if (field === 'image') {
    $('image-pick').toggleAttribute('data-invalid', !!msg);
  } else {
    const input = $(field);
    if (input) input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  }
}

function validate() {
  const errors = [];
  const check = (field, ok, msg) => { setErr(field, ok ? '' : msg); if (!ok) errors.push(field); };
  check('image', !!imageData, 'Ajoute une image pour ton coin.');
  check('name', $('name').value.trim().length > 0, 'Donne un nom à ton coin.');
  check('ticker', /^[A-Z0-9]{1,10}$/.test($('ticker').value), 'Ticker : 1 à 10 lettres ou chiffres.');
  check('ack', $('ack').checked, 'Coche cette case pour continuer.');
  if (tickerTaken && !errors.includes('ticker')) {
    setErr('ticker', `$${$('ticker').value} existe déjà sur Float. Choisis un autre ticker.`);
    errors.push('ticker');
  }
  if (errors.length) $(errors[0] === 'image' ? 'image' : errors[0])?.focus();
  return errors.length === 0;
}

$('ticker').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  tickerTaken = false;
  setErr('ticker', '');
  clearTimeout(tickerTimer);
  const t = e.target.value;
  if (!t) return;
  tickerTimer = setTimeout(async () => {
    try {
      const r = await api(`/api/ticker?t=${encodeURIComponent(t)}`);
      if ($('ticker').value !== t) return;
      tickerTaken = r.taken;
      setErr('ticker', r.taken ? `$${t} existe déjà sur Float. Choisis un autre ticker.` : '');
    } catch { /* vérifié de nouveau au lancement */ }
  }, 450);
});
$('name').addEventListener('input', () => setErr('name', ''));
$('ack').addEventListener('change', () => setErr('ack', ''));

$('image').addEventListener('change', () => {
  const f = $('image').files[0];
  if (!f) return;
  if (f.size > 1_000_000) { setErr('image', 'Image trop lourde : 1 Mo maximum.'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    imageData = reader.result;
    $('preview').src = imageData;
    $('preview').hidden = false;
    $('image-hint').hidden = true;
    setErr('image', '');
  };
  reader.readAsDataURL(f);
});

// ---------- Étapes : formulaire → vérification → signature → succès ----------
function show(view) {
  $('form').hidden = view !== 'form';
  $('review').hidden = view !== 'review';
  $('done').hidden = view !== 'done';
  const target = view === 'form' ? $('submit') : view === 'review' ? $('sign') : $('dn-raydium');
  target?.focus({ preventScroll: true });
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!validate()) { status('status', 'Corrige les champs signalés.', 'err'); return; }
  const btn = $('submit');
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  try {
    if (!wallet && !(await connect().catch(() => false))) { status('status', noWalletMsg(), 'err'); return; }

    status('status', 'Envoi de la fiche du coin… (1/2)');
    const form = {
      name: $('name').value.trim(), ticker: $('ticker').value, description: $('description').value,
      twitter: $('twitter').value, telegram: $('telegram').value, website: $('website').value,
      quoteMint: $('quote').value, tier: Number($('tier').value),
    };
    const meta = await api('/api/metadata', { ...form, image: imageData });

    status('status', 'Simulation du lancement sur Float… (2/2)');
    const built = await api('/api/launch/build', {
      creator: wallet, name: form.name, ticker: form.ticker, uri: meta.uri, quoteMint: form.quoteMint, tier: form.tier,
    });
    pending = { meta, built, form };
    fillReview();
    status('status', '');
    show('review');
  } catch (err) {
    const m = err.message || String(err);
    if (/ticker/i.test(m)) { setErr('ticker', m); $('ticker').focus(); }
    status('status', m, 'err');
  } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  }
});

function fillReview() {
  const { built, form } = pending;
  const q = quotes.find((x) => x.mint === form.quoteMint);
  const t = cfg?.tiers?.find((x) => x.tier === form.tier);
  $('rv-img').src = imageData;
  $('rv-name').textContent = form.name;
  $('rv-ticker').textContent = `$${form.ticker}`;
  $('rv-pair').textContent = q ? `${q.symbol} · ${q.name}` : short(form.quoteMint);
  $('rv-tier').textContent = t ? t.label : '';
  $('rv-receiver').textContent = short(built.feeReceiver);
  $('rv-receiver').href = `https://solscan.io/account/${built.feeReceiver}`;
  $('rv-cost').textContent = built.costSol != null ? `≈ ${fmt(built.costSol, 4)} SOL` : 'frais réseau et création des comptes';
  $('rv-sim').textContent = `réussie · ${built.accounts} comptes`;
  status('rv-status', '');
}

$('edit').addEventListener('click', () => { pending = null; show('form'); });

$('sign').addEventListener('click', async () => {
  if (!pending) return;
  const btn = $('sign');
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  $('edit').disabled = true;
  try {
    status('rv-status', 'Signe la transaction dans ton wallet.');
    const tx = solanaWeb3.VersionedTransaction.deserialize(Uint8Array.from(atob(pending.built.transaction), (c) => c.charCodeAt(0)));
    const { signature } = await provider.signAndSendTransaction(tx);
    status('rv-status', 'Transaction envoyée, confirmation sur Solana…');
    await api('/api/launch/confirm', { mint: pending.built.mint, signature, uri: pending.meta.uri });
    fillDone(signature);
    show('done');
    loadCoins();
  } catch (err) {
    const m = err.message || String(err);
    if (/reject|refus|cancel|denied/i.test(m)) {
      status('rv-status', 'Signature annulée. Rien n’a été envoyé : tu peux signer de nouveau ou modifier.', 'err');
    } else {
      // blockhash expiré ou envoi échoué : la transaction est reconstruite à la prochaine vérification
      pending = null;
      show('form');
      status('status', `${m}. Rien n'a été confirmé : relance la vérification.`, 'err');
    }
  } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    $('edit').disabled = false;
  }
});

function fillDone(signature) {
  const { built, form } = pending;
  $('dn-img').src = imageData;
  $('dn-name').textContent = form.name;
  $('dn-ticker').textContent = `$${form.ticker}`;
  $('dn-mint').textContent = built.mint;
  $('dn-raydium').href = `https://raydium.io/launchpad/token/?mint=${built.mint}`;
  $('dn-solscan').href = `https://solscan.io/tx/${signature}`;
}

$('dn-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('dn-mint').textContent);
    $('dn-copy').textContent = 'Adresse copiée';
  } catch {
    const r = document.createRange();
    r.selectNodeContents($('dn-mint'));
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  }
});

$('dn-again').addEventListener('click', () => {
  pending = null;
  imageData = null;
  tickerTaken = false;
  $('form').reset();
  $('preview').hidden = true;
  $('image-hint').hidden = false;
  ['image', 'name', 'ticker', 'ack'].forEach((f) => setErr(f, ''));
  selectPair(quotes[0]?.mint);
  updateTierHint();
  $('dn-copy').textContent = 'Copier l’adresse du mint';
  show('form');
});

// ---------- Paires ----------
function selectPair(mint) {
  if (!mint) return;
  $('quote').value = mint;
  for (const li of $('pair-rows').querySelectorAll('li[data-mint]')) li.setAttribute('aria-selected', String(li.dataset.mint === mint));
}
$('quote').addEventListener('change', () => selectPair($('quote').value));

function renderPairs(list) {
  quotes = list;
  const crypto = list.filter((q) => q.symbol === 'SOL' || q.symbol === 'USDC');
  const stocks = list.filter((q) => !crypto.includes(q));
  const opt = (q) => el('option', { value: q.mint }, `${q.symbol} · ${q.name}`);
  $('quote').replaceChildren(
    el('optgroup', { label: 'Crypto' }, ...crypto.map(opt)),
    el('optgroup', { label: `Actions tokenisées (${stocks.length})` }, ...stocks.map(opt)));

  const row = (q) => {
    const li = el('li', { 'data-mint': q.mint, role: 'option', tabindex: '0' },
      q.icon ? el('img', { src: q.icon, alt: '', loading: 'lazy', width: '28', height: '28' }) : el('span', { class: 'pairs__dot' }),
      el('b', {}, q.symbol), el('em', {}, q.symbol === 'SOL' ? 'Natif' : q.symbol === 'USDC' ? 'Stable' : 'xStock'), el('span', {}, q.name));
    const pick = () => selectPair(q.mint);
    li.addEventListener('click', pick);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    return li;
  };
  $('pair-rows').setAttribute('role', 'listbox');
  $('pair-rows').replaceChildren(
    el('li', { class: 'pairs__group', role: 'presentation' }, 'Crypto'), ...crypto.map(row),
    el('li', { class: 'pairs__group', role: 'presentation' }, `Actions tokenisées · ${stocks.length}`), ...stocks.map(row));
  if (list[0]) selectPair(list[0].mint);
}

function updateTierHint() {
  const t = cfg?.tiers?.find((x) => String(x.tier) === $('tier').value);
  $('tier-hint').textContent = t?.per100
    ? `Le wallet reçoit ≈ ${fmt(t.per100, 4)} SOL pour 100 SOL échangés sur ton coin. Un fee plus bas attire souvent plus de volume.`
    : '';
}
$('tier').addEventListener('change', updateTierHint);

// ---------- Données ----------
const SPLIT = [
  ['creator', 'Créateur, vers le wallet public', '#5ab9fc'],
  ['holders', 'Holders du coin', '#8fd3a8'],
  ['flagship', 'Rachat de $FLOAT', '#c9a45a'],
  ['traders', 'Traders actifs', '#e3e7ee'],
  ['treasury', 'Trésorerie Float', '#5b6577'],
];

async function loadConfig() {
  cfg = await api('/api/config');
  $('receiver').textContent = short(cfg.feeReceiver);
  $('receiver').title = cfg.feeReceiver;
  $('wallet-link').href = `https://solscan.io/account/${cfg.feeReceiver}`;
  $('bb-pct').textContent = `${cfg.buybackPct} %`;
  $('keep-pct').textContent = `${100 - cfg.buybackPct} %`;
  $('tier').replaceChildren(...cfg.tiers.map((t) => el('option', { value: t.tier }, t.label)));
  updateTierHint();

  if (cfg.float?.split) {
    const s = cfg.float.split;
    $('split-bar').replaceChildren(...SPLIT.map(([k, , c]) => el('i', { style: `flex:${s[k]};background:${c}` })));
    $('split-legend').replaceChildren(...SPLIT.map(([k, label, c]) =>
      el('li', { style: `--c:${c}`, class: k === 'creator' ? 'is-you' : '' }, label, el('b', {}, `${s[k] / 100} %`))));
  } else if (cfg.float?.error) {
    status('status', `Float n'accepte pas de lancement pour le moment : ${cfg.float.error}`, 'err');
  }

  const r = cfg.rules || {};
  $('rules').replaceChildren(...[
    ['Taille par trade', `${r.maxPositionPct} % du wallet`],
    ['Positions ouvertes', `${r.maxOpenPositions} max`],
    ['Stop-loss', `−${r.stopLossPct} %`],
    ['Prise de profit', `+${r.takeProfitPct} %`],
    ['Pause journalière', `−${r.maxDailyLossPct} %`],
  ].map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', {}, v))));

  renderPairs(await api('/api/quotes'));
}

async function loadTrader() {
  const t = await api('/api/trader');
  const who = t.label || (t.address ? short(t.address) : null);
  if (!who) {
    $('hero-trader-name').textContent = 'Trader n°1 FOMO';
    $('hero-trader-meta').textContent = 'copié dès l’ouverture';
    return;
  }
  $('hero-trader-name').textContent = who;
  $('hero-trader-meta').textContent = t.lastActiveAt ? `actif ${ago(t.lastActiveAt)}` : 'copié en direct';
  $('trader-name').replaceChildren(t.label ? t.label : el('code', {}, short(t.address)));
  const usd = (n) => `${n >= 0 ? '+' : '−'}${Math.abs(Math.round(n)).toLocaleString('fr-FR')} $`;
  $('trader-meta').textContent = [
    t.mode === 'TOP1' ? `N°${t.rank ?? 1} du classement FOMO${t.window ? ` (${t.window})` : ''}` : `Panier de ${t.count} traders FOMO`,
    t.pnlUsd != null ? `${usd(t.pnlUsd)} selon FOMO` : null,
    t.lastActiveAt ? `dernier trade ${ago(t.lastActiveAt)}` : null,
    t.recentTx ? `${t.recentTx} transactions sur 24 h` : null,
    t.auto && t.checkedAt ? `classement vérifié ${ago(t.checkedAt)}` : null,
  ].filter(Boolean).join(' · ');
  const link = $('trader-link');
  if (t.url) { link.href = t.url; link.hidden = false; }
  else if (t.address) { link.href = `https://solscan.io/account/${t.address}`; link.textContent = 'Voir sur Solscan'; link.hidden = false; }
}

async function loadCoins() {
  const coins = await api('/api/coins');
  const box = $('coin-list');
  if (!coins.length) {
    box.replaceChildren(el('figure', { class: 'coins__empty' },
      el('p', {}, 'Aucun coin lancé pour l’instant. Le tien sera le premier de la liste.'),
      el('a', { class: 'btn btn--secondary', href: '#launch' }, 'Lancer un coin')));
    return;
  }
  box.replaceChildren(...coins.map((c) => el('a', { class: 'coin', href: `https://solscan.io/token/${c.mint}`, target: '_blank', rel: 'noopener' },
    el('img', { src: c.image, alt: '', loading: 'lazy' }),
    el('b', {}, `${c.name} · $${c.ticker}`),
    el('small', {}, `Paire ${c.quoteSymbol || short(c.quoteMint)}`),
    el('small', {}, short(c.mint)))));
}

const EVENT_LABEL = { convert: 'Fees convertis en SOL', buy: 'Achat copié', sell: 'Vente', buyback: 'Rachat', burn: 'Burn', pause: 'Pause du moteur' };

async function loadStats() {
  const s = await api('/api/stats');
  const empty = !s.balanceSol && !s.totalFeesSol && !s.realizedPnlSol && !s.events.length;
  $('zero-state').hidden = !empty;
  $('wallet-rows').classList.toggle('is-zero', empty);
  $('s-balance').textContent = sol(s.balanceSol);
  $('s-fees').textContent = sol(s.totalFeesSol);
  const pnl = $('s-pnl');
  pnl.textContent = `${s.realizedPnlSol > 0 ? '+' : ''}${sol(s.realizedPnlSol)}`;
  pnl.className = s.realizedPnlSol > 0 ? 'pos' : s.realizedPnlSol < 0 ? 'neg' : '';
  $('s-bucket').textContent = sol(s.buybackBucketSol);
  $('s-address').textContent = s.wallet;
  $('s-dry').hidden = !s.dryRun;

  $('positions').replaceChildren(...(s.positions.length
    ? s.positions.map((p) => el('div', { class: 'item' }, el('span', {}, short(p.mint)), el('span', {}, sol(p.costSol))))
    : [el('div', { class: 'empty' }, 'Aucune position ouverte.')]));

  $('events').replaceChildren(...(s.events.length
    ? s.events.map((ev) => {
      const d = ev.detail || {};
      const sig = d.sig ? el('a', { href: `https://solscan.io/tx/${d.sig}`, target: '_blank', rel: 'noopener' }, 'tx') : '';
      const extra = d.pnl != null ? `${d.pnl > 0 ? '+' : ''}${fmt(d.pnl, 4)} SOL` : d.ticker ? `$${d.ticker}` : d.sol ? sol(d.sol) : '';
      return el('div', { class: 'item' },
        el('span', {}, `${EVENT_LABEL[ev.kind] || ev.kind} ${extra}`),
        el('span', { class: 'muted' }, new Date(ev.t).toLocaleString('fr-FR'), ' ', sig));
    })
    : [el('div', { class: 'empty' }, 'Les trades copiés, rachats et burns s’afficheront ici, avec leur transaction.')]));
}

loadConfig().catch((e) => status('status', e.message, 'err'));
loadTrader().catch(() => {});
loadCoins().catch(() => {});
loadStats().catch(() => {});
setInterval(() => loadStats().catch(() => {}), 30_000);
