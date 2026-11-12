/**
 * Serveur du launchpad.
 *  - héberge le site (public/) et les métadonnées des coins (/m/<id>.json, /img/<id>)
 *  - construit les transactions de lancement Float (fee_receiver = wallet public du launchpad)
 *  - vérifie les lancements on-chain et tient le registre des coins
 *  - expose les stats du wallet de copy-trading pour le dashboard
 * Le serveur ne détient AUCUNE clé : l'utilisateur signe le lancement avec son wallet.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { config, SOL_MINT } from './engine/config.js';
import { connection, feeReceiver } from './engine/solana.js';
import { readEngineState } from './engine/state.js';
import {
  buildLaunchIx, checkFloatConfig, isQuoteEnabled, isTickerTaken, readLaunchState, validateLaunch,
  FEE_TIERS, derive,
} from './float.js';
import { addCoin, listCoins } from './registry.js';
import { readLeaderState, leaderWallets } from './engine/leaderboard.js';

const PUBLIC_DIR = path.resolve('public');
const META_DIR = path.join(config.dataDir, 'm');
const IMG_DIR = path.join(config.dataDir, 'img');
fs.mkdirSync(META_DIR, { recursive: true });
fs.mkdirSync(IMG_DIR, { recursive: true });

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MAX_IMAGE_BYTES = 1_000_000;
const IMG_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
};

// ---------- Paires disponibles (SOL, USDC + xStocks activés sur Float) ----------
interface Quote { mint: string; symbol: string; name: string; icon?: string }
let quotesCache: { at: number; list: Quote[] } = { at: 0, list: [] };

async function availableQuotes(): Promise<Quote[]> {
  if (Date.now() - quotesCache.at < 3_600_000 && quotesCache.list.length) return quotesCache.list;
  const list: Quote[] = [
    { mint: SOL_MINT, symbol: 'SOL', name: 'Solana' },
    { mint: USDC, symbol: 'USDC', name: 'USD Coin' },
  ];
  try {
    // icônes officielles de SOL et USDC depuis la liste de tokens Jupiter
    for (const q of list) {
      const r = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${q.mint}`);
      const [t] = (await r.json()) as { icon?: string }[];
      if (t?.icon) q.icon = t.icon;
    }
    const r = await fetch('https://lite-api.jup.ag/tokens/v2/search?query=xStock');
    const tokens = (await r.json()) as { id: string; symbol: string; name: string; icon?: string; tags?: string[] }[];
    const stocks = tokens.filter((t) => t.tags?.includes('xstocks'));
    for (let i = 0; i < stocks.length; i += 10) {
      const chunk = stocks.slice(i, i + 10);
      const accs = await connection.getMultipleAccountsInfo(chunk.map((t) => derive.quoteAsset(new PublicKey(t.id))));
      chunk.forEach((t, j) => { if (accs[j]) list.push({ mint: t.id, symbol: t.symbol, name: t.name, icon: t.icon }); });
    }
  } catch (e) {
    console.warn('Liste des xStocks indisponible :', (e as Error).message);
  }
  quotesCache = { at: Date.now(), list };
  return list;
}

// ---------- Helpers HTTP ----------
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

function send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) : (body as Buffer | string);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

async function readJson(req: http.IncomingMessage, limit = 2_000_000): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Requête trop volumineuse');
    chunks.push(c as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'JSON invalide'); }
}

function pubkey(v: unknown, label: string): PublicKey {
  try { return new PublicKey(String(v)); } catch { throw new HttpError(400, `${label} invalide`); }
}

const clean = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
const safeUrl = (v: unknown) => { const s = clean(v, 200); return /^https:\/\/[^\s]+$/.test(s) ? s : ''; };

// ---------- API ----------
async function apiMetadata(body: any) {
  const name = clean(body.name, 32);
  const ticker = clean(body.ticker, 10);
  validateLaunch({ name, ticker, uri: 'x', tier: 0 });
  const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(String(body.image ?? ''));
  if (!m || !IMG_TYPES[m[1]]) throw new HttpError(400, 'Image PNG, JPG, WEBP ou GIF requise');
  const img = Buffer.from(m[2], 'base64');
  if (img.length > MAX_IMAGE_BYTES) throw new HttpError(400, 'Image trop lourde (1 Mo max)');

  const id = crypto.randomBytes(9).toString('base64url');
  const imgFile = `${id}.${IMG_TYPES[m[1]]}`;
  fs.writeFileSync(path.join(IMG_DIR, imgFile), img);

  const twitter = safeUrl(body.twitter), telegram = safeUrl(body.telegram), website = safeUrl(body.website);
  const meta = {
    name, symbol: ticker.toUpperCase(),
    description: clean(body.description, 500),
    image: `${config.publicUrl}/img/${imgFile}`,
    ...(twitter && { twitter }), ...(telegram && { telegram }), ...(website && { website }),
    extensions: { ...(twitter && { twitter }), ...(telegram && { telegram }), ...(website && { website }) },
    createdOn: config.publicUrl,
  };
  fs.writeFileSync(path.join(META_DIR, `${id}.json`), JSON.stringify(meta));
  return { uri: `${config.publicUrl}/m/${id}.json`, image: meta.image };
}

async function apiBuildLaunch(body: any) {
  const creator = pubkey(body.creator, 'Wallet');
  const quoteMint = pubkey(body.quoteMint, 'Paire');
  const name = clean(body.name, 32);
  const ticker = clean(body.ticker, 10);
  const uri = clean(body.uri, 200);
  const tier = Number(body.tier) as 0 | 1 | 2;
  if (!uri.startsWith(`${config.publicUrl}/m/`)) throw new HttpError(400, 'Métadonnées non hébergées par ce launchpad');
  validateLaunch({ name, ticker, uri, tier });

  await checkFloatConfig(connection);
  if (!(await isQuoteEnabled(connection, quoteMint))) throw new HttpError(400, "Cette paire n'est pas activée sur Float");
  if (await isTickerTaken(connection, ticker)) {
    throw new HttpError(409, 'Ce ticker existe déjà sur Float (le reprendre coûte 2 SOL) : choisis-en un autre');
  }
  const quoteInfo = await connection.getAccountInfo(quoteMint);
  if (!quoteInfo) throw new HttpError(400, 'Mint de la paire introuvable');
  const quoteTokenProgram = quoteInfo.owner;

  const nonce = crypto.randomBytes(8).readBigUInt64LE();
  const { ix, mint } = buildLaunchIx({ creator, feeReceiver, name, ticker, uri, quoteMint, quoteTokenProgram, tier, nonce });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: creator,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      ix,
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);

  // Simulation avant signature : l'utilisateur ne signe jamais une transaction qui échouerait.
  const [sim, preLamports] = await Promise.all([
    connection.simulateTransaction(tx, { sigVerify: false, accounts: { encoding: 'base64', addresses: [creator.toBase58()] } }),
    connection.getBalance(creator),
  ]);
  if (sim.value.err) {
    const logs = (sim.value.logs ?? []).filter((l) => /Error|insufficient|failed/i.test(l)).slice(-3).join(' | ');
    const lowSol = /insufficient lamports|0x1\b/.test(logs) || JSON.stringify(sim.value.err).includes('AccountNotFound');
    throw new HttpError(400, lowSol ? 'Pas assez de SOL sur ton wallet pour lancer' : `Simulation refusée par Float : ${logs || JSON.stringify(sim.value.err)}`);
  }
  const post = sim.value.accounts?.[0]?.lamports;
  const costSol = post != null ? Math.max(0, preLamports - post) / LAMPORTS_PER_SOL : null;
  return {
    costSol,
    accounts: ix.keys.length,
    transaction: Buffer.from(tx.serialize()).toString('base64'),
    mint: mint.toBase58(),
    lastValidBlockHeight,
    feeReceiver: feeReceiver.toBase58(),
  };
}

async function apiConfirmLaunch(body: any) {
  const mint = pubkey(body.mint, 'Mint');
  const signature = clean(body.signature, 100);
  // Le lancement peut mettre quelques secondes à être visible : on réessaie.
  let ls = null;
  for (let i = 0; i < 10 && !ls; i++) {
    ls = await readLaunchState(connection, mint);
    if (!ls) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!ls) throw new HttpError(404, 'Lancement introuvable on-chain');
  if (ls.feeReceiver !== feeReceiver.toBase58()) throw new HttpError(400, "Ce coin ne reverse pas ses fees à ce launchpad");

  const metaId = /\/m\/([\w-]+)\.json$/.exec(clean(body.uri, 200))?.[1];
  const meta = metaId && fs.existsSync(path.join(META_DIR, `${metaId}.json`))
    ? JSON.parse(fs.readFileSync(path.join(META_DIR, `${metaId}.json`), 'utf8')) : {};
  const quotes = await availableQuotes();
  addCoin({
    mint: mint.toBase58(),
    name: meta.name ?? '', ticker: meta.symbol ?? '', image: meta.image ?? '', description: meta.description ?? '',
    quoteMint: ls.quoteMint, quoteSymbol: quotes.find((q) => q.mint === ls!.quoteMint)?.symbol ?? '',
    tier: ls.feeTier, creator: ls.creator, signature, launchedAt: Date.now(),
  });
  return { ok: true, mint: mint.toBase58() };
}

async function apiStats() {
  const s = readEngineState();
  const balance = (await connection.getBalance(feeReceiver)) / LAMPORTS_PER_SOL;
  return {
    wallet: feeReceiver.toBase58(),
    balanceSol: balance,
    traders: leaderWallets(),
    mode: config.mode,
    totalFeesSol: s.totalFeesSol,
    realizedPnlSol: s.realizedPnlSol,
    buybackBucketSol: s.buybackBucketSol,
    positions: Object.values(s.positions),
    coins: s.coins,
    events: s.events.slice(-50).reverse(),
    dryRun: config.dryRun,
  };
}

let traderCache: { at: number; data: unknown } = { at: 0, data: null };
async function apiTrader() {
  if (Date.now() - traderCache.at < 60_000 && traderCache.data) return traderCache.data;
  const leader = config.traderSource === 'fomo' ? readLeaderState() : null;
  const top = leader?.current[0];
  const address = top?.wallets[0] ?? leaderWallets()[0] ?? null;
  let lastActiveAt: number | null = null;
  let recentTx = 0;
  if (address) {
    try {
      const sigs = await connection.getSignaturesForAddress(new PublicKey(address), { limit: 25 });
      lastActiveAt = sigs[0]?.blockTime ? sigs[0].blockTime * 1000 : null;
      const dayAgo = Date.now() / 1000 - 86_400;
      recentTx = sigs.filter((x) => (x.blockTime ?? 0) > dayAgo && !x.err).length;
    } catch { /* RPC indisponible : on renvoie l'adresse seule */ }
  }
  const data = {
    address,
    label: top ? `@${top.handle}` : config.traderLabel || null,
    url: config.traderUrl || null,
    rank: top?.rank ?? null,
    pnlUsd: top?.pnlUsd ?? null,
    window: top?.window ?? null,
    checkedAt: leader?.checkedAt ?? null,
    changedAt: leader?.changedAt ?? null,
    auto: config.traderSource === 'fomo',
    lastActiveAt, recentTx, mode: config.mode, count: leader?.current.length ?? config.traders.length,
  };
  traderCache = { at: Date.now(), data };
  return data;
}

async function apiTicker(t: string) {
  const ticker = clean(t, 10);
  if (!/^[A-Za-z0-9]{1,10}$/.test(ticker)) throw new HttpError(400, 'Ticker : 1 à 10 lettres ou chiffres');
  return { ticker: ticker.toUpperCase(), taken: await isTickerTaken(connection, ticker) };
}

async function apiConfig() {
  const cfg = await checkFloatConfig(connection).catch((e) => ({ error: (e as Error).message }));
  return {
    siteName: config.siteName,
    feeReceiver: feeReceiver.toBase58(),
    tiers: FEE_TIERS.map((t) => {
      const creatorBps = 'split' in cfg ? cfg.split.creator : 0;
      // taux Float en unités LaunchLab (10 000 = 1 %) ; part du wallet pour 100 SOL échangés
      const per100 = (Number(t.floatRate) / 1_000_000) * 100 * (creatorBps / 10_000);
      return { tier: t.tier, label: t.label, per100 };
    }),
    float: cfg,
    buybackPct: config.buybackPct,
    rules: {
      maxPositionPct: config.maxPositionPct,
      maxOpenPositions: config.maxOpenPositions,
      stopLossPct: config.stopLossPct,
      takeProfitPct: config.takeProfitPct,
      maxDailyLossPct: config.maxDailyLossPct,
    },
  };
}

// ---------- Routeur ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;

    if (req.method === 'POST' && ['/api/metadata', '/api/launch/build', '/api/launch/confirm'].includes(p)) {
      const origin = req.headers.origin;
      if (origin && origin !== config.publicUrl && !config.publicUrl.startsWith('http://localhost')) {
        throw new HttpError(403, 'Origine refusée');
      }
      const body = await readJson(req);
      if (p === '/api/metadata') return send(res, 200, await apiMetadata(body));
      if (p === '/api/launch/build') return send(res, 200, await apiBuildLaunch(body));
      return send(res, 200, await apiConfirmLaunch(body));
    }
    if (req.method !== 'GET') throw new HttpError(405, 'Méthode non autorisée');

    if (p === '/api/config') return send(res, 200, await apiConfig());
    if (p === '/api/quotes') return send(res, 200, await availableQuotes());
    if (p === '/api/coins') return send(res, 200, listCoins());
    if (p === '/api/stats') return send(res, 200, await apiStats());
    if (p === '/api/trader') return send(res, 200, await apiTrader());
    if (p === '/api/ticker') return send(res, 200, await apiTicker(url.searchParams.get('t') ?? ''));

    let file: string | null = null;
    const meta = /^\/m\/([\w-]+\.json)$/.exec(p);
    const img = /^\/img\/([\w-]+\.(png|jpg|webp|gif))$/.exec(p);
    if (meta) file = path.join(META_DIR, meta[1]);
    else if (img) file = path.join(IMG_DIR, img[1]);
    else {
      const rel = p === '/' ? 'index.html' : p.slice(1);
      const full = path.resolve(PUBLIC_DIR, rel);
      if (full.startsWith(PUBLIC_DIR + path.sep)) file = full;
    }
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'Introuvable');
    const ext = path.extname(file).slice(1);
    const hosted = !!(meta || img);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': hosted ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...(hosted && { 'Access-Control-Allow-Origin': '*' }),
    });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    send(res, status, { error: status === 500 ? 'Erreur serveur' : (e as Error).message });
  }
});

server.listen(config.port, () => {
  console.log(`${config.siteName} → ${config.publicUrl} (port ${config.port})`);
  console.log(`fee_receiver = ${feeReceiver.toBase58()}`);
});
