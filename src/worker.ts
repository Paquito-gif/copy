/**
 * Worker principal : site (assets statiques), API de lancement Float, métadonnées (R2),
 * registre des coins (D1), tâches planifiées (classement FOMO toutes les 5 h, fees toutes les heures).
 * Le Worker ne signe jamais rien : l'utilisateur signe le lancement dans son wallet.
 */
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { type Env, settings, SOL_MINT, USDC_MINT } from './lib/env.js';
import { Rpc, LAMPORTS_PER_SOL, b64 } from './lib/rpc.js';
import {
  buildLaunchIx, checkFloatConfig, isQuoteEnabled, isTickerTaken, readLaunchState, validateLaunch, FEE_TIERS, derive,
} from './float.js';

export { CopyEngine } from './engine.js';

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra },
  });

const clean = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
const safeUrl = (v: unknown) => { const s = clean(v, 200); return /^https:\/\/[^\s]+$/.test(s) ? s : ''; };
const pubkey = (v: unknown, label: string) => { try { return new PublicKey(String(v)); } catch { throw new HttpError(400, `${label} invalide`); } };
const IMG_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

const engine = (env: Env) => env.ENGINE.get(env.ENGINE.idFromName('main'));
const engineCall = async (env: Env, path: string) => {
  const r = await engine(env).fetch(`https://engine${path}`, { method: 'POST' });
  return r.json() as Promise<any>;
};

function randomId(bytes = 9) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const cache = caches.default;
  const req = new Request(`https://cache.internal/${key}`);
  const hit = await cache.match(req);
  if (hit) return hit.json() as Promise<T>;
  const data = await fn();
  await cache.put(req, new Response(JSON.stringify(data), { headers: { 'Cache-Control': `max-age=${ttl}` } }));
  return data;
}

// ---------- API ----------
async function apiQuotes(env: Env) {
  return cached('quotes-v1', 3600, async () => {
    const rpc = new Rpc(env.RPC_URL);
    const list: { mint: string; symbol: string; name: string; icon?: string }[] = [
      { mint: SOL_MINT, symbol: 'SOL', name: 'Solana' },
      { mint: USDC_MINT, symbol: 'USDC', name: 'USD Coin' },
    ];
    try {
      for (const q of list) {
        const [t] = (await (await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${q.mint}`)).json()) as { icon?: string }[];
        if (t?.icon) q.icon = t.icon;
      }
      const tokens = (await (await fetch('https://lite-api.jup.ag/tokens/v2/search?query=xStock')).json()) as { id: string; symbol: string; name: string; icon?: string; tags?: string[] }[];
      const stocks = tokens.filter((t) => t.tags?.includes('xstocks'));
      const accs = await rpc.getMultipleAccounts(stocks.map((t) => derive.quoteAsset(new PublicKey(t.id)).toBase58()));
      stocks.forEach((t, i) => { if (accs[i]) list.push({ mint: t.id, symbol: t.symbol, name: t.name, icon: t.icon }); });
    } catch { /* liste réduite à SOL et USDC */ }
    return list;
  });
}

async function apiConfig(env: Env) {
  const s = settings(env);
  const cfg = await checkFloatConfig(new Rpc(env.RPC_URL)).catch((e) => ({ error: (e as Error).message }));
  return {
    siteName: s.siteName,
    feeReceiver: s.feeReceiver,
    tiers: FEE_TIERS.map((t) => {
      const creatorBps = 'split' in cfg ? cfg.split.creator : 0;
      return { tier: t.tier, label: t.label, per100: (Number(t.floatRate) / 1_000_000) * 100 * (creatorBps / 10_000) };
    }),
    float: cfg,
    buybackPct: s.buybackPct,
    rules: { maxPositionPct: s.maxPositionPct, maxOpenPositions: s.maxOpenPositions, stopLossPct: s.stopLossPct, takeProfitPct: s.takeProfitPct, maxDailyLossPct: s.maxDailyLossPct },
  };
}

async function apiMetadata(env: Env, origin: string, body: any) {
  const name = clean(body.name, 32);
  const ticker = clean(body.ticker, 10);
  validateLaunch({ name, ticker, uri: 'x', tier: 0 });
  const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(String(body.image ?? ''));
  if (!m || !IMG_TYPES[m[1]]) throw new HttpError(400, 'Image PNG, JPG, WEBP ou GIF requise');
  const img = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  if (img.length > 1_000_000) throw new HttpError(400, 'Image trop lourde (1 Mo max)');

  const id = randomId();
  const imgFile = `${id}.${IMG_TYPES[m[1]]}`;
  await env.FILES.put(`img/${imgFile}`, img, { httpMetadata: { contentType: m[1], cacheControl: 'public, max-age=31536000, immutable' } });
  const twitter = safeUrl(body.twitter), telegram = safeUrl(body.telegram), website = safeUrl(body.website);
  const meta = {
    name, symbol: ticker.toUpperCase(), description: clean(body.description, 500), image: `${origin}/img/${imgFile}`,
    ...(twitter && { twitter }), ...(telegram && { telegram }), ...(website && { website }),
    extensions: { ...(twitter && { twitter }), ...(telegram && { telegram }), ...(website && { website }) },
    createdOn: origin,
  };
  await env.FILES.put(`m/${id}.json`, JSON.stringify(meta), { httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=31536000, immutable' } });
  return { uri: `${origin}/m/${id}.json`, image: meta.image };
}

async function apiBuild(env: Env, origin: string, body: any) {
  const rpc = new Rpc(env.RPC_URL);
  const feeReceiver = pubkey(env.FEE_RECEIVER, 'FEE_RECEIVER');
  const creator = pubkey(body.creator, 'Wallet');
  const quoteMint = pubkey(body.quoteMint, 'Paire');
  const name = clean(body.name, 32), ticker = clean(body.ticker, 10), uri = clean(body.uri, 200);
  const tier = Number(body.tier) as 0 | 1 | 2;
  if (!uri.startsWith(`${origin}/m/`)) throw new HttpError(400, 'Métadonnées non hébergées par ce launchpad');
  validateLaunch({ name, ticker, uri, tier });

  await checkFloatConfig(rpc);
  if (!(await isQuoteEnabled(rpc, quoteMint))) throw new HttpError(400, "Cette paire n'est pas activée sur Float");
  if (await isTickerTaken(rpc, ticker)) throw new HttpError(409, 'Ce ticker existe déjà sur Float (le reprendre coûte 2 SOL) : choisis-en un autre');
  const quoteInfo = await rpc.getAccountInfo(quoteMint.toBase58());
  if (!quoteInfo) throw new HttpError(400, 'Mint de la paire introuvable');

  const nonce = new DataView(crypto.getRandomValues(new Uint8Array(8)).buffer).getBigUint64(0, true);
  const { ix, mint } = buildLaunchIx({ creator, feeReceiver, name, ticker, uri, quoteMint, quoteTokenProgram: new PublicKey(quoteInfo.owner), tier, nonce });
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: creator, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }), ix],
  }).compileToV0Message());
  const txB64 = b64(tx.serialize());

  // simulation avant signature : l'utilisateur ne signe jamais une transaction qui échouerait
  const [sim, pre] = await Promise.all([rpc.simulate(txB64, { accounts: [creator.toBase58()] }), rpc.getBalance(creator.toBase58())]);
  if (sim.err) {
    const logs = (sim.logs ?? []).filter((l) => /Error|insufficient|failed/i.test(l)).slice(-3).join(' | ');
    const lowSol = /insufficient lamports|0x1\b/.test(logs) || JSON.stringify(sim.err).includes('AccountNotFound');
    throw new HttpError(400, lowSol ? 'Pas assez de SOL sur ton wallet pour lancer' : `Simulation refusée par Float : ${logs || JSON.stringify(sim.err)}`);
  }
  const post = sim.accounts?.[0]?.lamports;
  return {
    costSol: post != null ? Math.max(0, pre - post) / LAMPORTS_PER_SOL : null,
    accounts: ix.keys.length, transaction: txB64, mint: mint.toBase58(), lastValidBlockHeight, feeReceiver: feeReceiver.toBase58(),
  };
}

async function apiConfirm(env: Env, origin: string, body: any) {
  const rpc = new Rpc(env.RPC_URL);
  const mint = pubkey(body.mint, 'Mint');
  const signature = clean(body.signature, 100);
  let ls = null;
  for (let i = 0; i < 10 && !ls; i++) {
    ls = await readLaunchState(rpc, mint);
    if (!ls) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!ls) throw new HttpError(404, 'Lancement introuvable on-chain');
  if (ls.feeReceiver !== env.FEE_RECEIVER) throw new HttpError(400, 'Ce coin ne reverse pas ses fees à ce launchpad');

  const metaId = /\/m\/([\w-]+)\.json$/.exec(clean(body.uri, 200))?.[1];
  const obj = metaId ? await env.FILES.get(`m/${metaId}.json`) : null;
  const meta = obj ? ((await obj.json()) as any) : {};
  const quotes = await apiQuotes(env);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO coins (mint, name, ticker, image, description, quote_mint, quote_symbol, tier, creator, signature, launched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(mint.toBase58(), meta.name ?? '', meta.symbol ?? '', meta.image ?? '', meta.description ?? '', ls.quoteMint,
    quotes.find((q) => q.mint === ls!.quoteMint)?.symbol ?? '', ls.feeTier, ls.creator, signature, Date.now()).run();
  return { ok: true, mint: mint.toBase58() };
}

async function apiCoins(env: Env) {
  const r = await env.DB.prepare('SELECT * FROM coins ORDER BY launched_at DESC LIMIT 200').all<any>();
  return r.results.map((c) => ({
    mint: c.mint, name: c.name, ticker: c.ticker, image: c.image, description: c.description,
    quoteMint: c.quote_mint, quoteSymbol: c.quote_symbol, tier: c.tier, creator: c.creator, signature: c.signature, launchedAt: c.launched_at,
  }));
}

async function engineState(env: Env): Promise<any> {
  return (await engine(env).fetch('https://engine/state')).json();
}

async function apiStats(env: Env) {
  const [st, bal] = await Promise.all([engineState(env), new Rpc(env.RPC_URL).getBalance(env.FEE_RECEIVER).catch(() => 0)]);
  return {
    wallet: env.FEE_RECEIVER, balanceSol: bal / LAMPORTS_PER_SOL, traders: st.wallets, mode: st.mode,
    totalFeesSol: st.totalFeesSol, realizedPnlSol: st.realizedPnlSol, buybackBucketSol: st.buybackBucketSol,
    positions: Object.values(st.positions), coins: st.coins,
    events: st.events.filter((e: any) => ['convert', 'buy', 'sell', 'buyback', 'burn', 'pause'].includes(e.kind)).slice(-50).reverse(),
    dryRun: st.dryRun, running: st.running, engineError: st.lastError ?? null, leaderError: st.leader?.error ?? null,
    leaderCheckedAt: st.leader?.checkedAt ?? null,
  };
}

async function apiTrader(env: Env) {
  return cached('trader-v1', 60, async () => {
    const st = await engineState(env);
    const top = st.leader?.current?.[0];
    const address = top?.wallets?.[0] ?? st.wallets?.[0] ?? null;
    let lastActiveAt: number | null = null, recentTx = 0;
    if (address) {
      try {
        const sigs = await new Rpc(env.RPC_URL).getSignatures(address, { limit: 25 });
        lastActiveAt = sigs[0]?.blockTime ? sigs[0].blockTime * 1000 : null;
        recentTx = sigs.filter((x) => (x.blockTime ?? 0) > Date.now() / 1000 - 86_400 && !x.err).length;
      } catch { /* RPC indisponible */ }
    }
    return {
      address, label: top ? `@${top.handle}` : null, url: null, rank: top?.rank ?? null, pnlUsd: top?.pnlUsd ?? null,
      window: top?.window ?? null, checkedAt: st.leader?.checkedAt ?? null, changedAt: st.leader?.changedAt ?? null,
      auto: settings(env).traderSource === 'fomo', lastActiveAt, recentTx, mode: st.mode, count: st.leader?.current?.length ?? 0,
      running: st.running,
    };
  });
}

async function apiAdmin(env: Env, req: Request, body: any) {
  if (!env.ADMIN_TOKEN || req.headers.get('Authorization') !== `Bearer ${env.ADMIN_TOKEN}`) throw new HttpError(401, 'Non autorisé');
  const action = String(body.action ?? '');
  if (!['start', 'pause', 'scan', 'fees'].includes(action)) throw new HttpError(400, 'action : start | pause | scan | fees');
  return engineCall(env, `/${action}`);
}

// ---------- routeur ----------
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    const origin = (env.PUBLIC_URL || url.origin).replace(/\/$/, '');
    try {
      if (req.method === 'POST' && p.startsWith('/api/')) {
        const o = req.headers.get('Origin');
        if (o && o !== origin && o !== url.origin && !p.startsWith('/api/admin/')) throw new HttpError(403, 'Origine refusée');
        const len = Number(req.headers.get('Content-Length') ?? 0);
        if (len > 2_000_000) throw new HttpError(413, 'Requête trop volumineuse');
        let body: any;
        try { body = await req.json(); } catch { throw new HttpError(400, 'JSON invalide'); }
        if (p === '/api/metadata') return json(await apiMetadata(env, origin, body));
        if (p === '/api/launch/build') return json(await apiBuild(env, origin, body));
        if (p === '/api/launch/confirm') return json(await apiConfirm(env, origin, body));
        if (p === '/api/admin/engine') return json(await apiAdmin(env, req, body));
        throw new HttpError(404, 'Introuvable');
      }
      if (req.method === 'GET') {
        if (p === '/api/config') return json(await apiConfig(env));
        if (p === '/api/quotes') return json(await apiQuotes(env));
        if (p === '/api/coins') return json(await apiCoins(env));
        if (p === '/api/stats') return json(await apiStats(env));
        if (p === '/api/trader') return json(await apiTrader(env));
        if (p === '/api/ticker') {
          const t = clean(url.searchParams.get('t'), 10);
          if (!/^[A-Za-z0-9]{1,10}$/.test(t)) throw new HttpError(400, 'Ticker : 1 à 10 lettres ou chiffres');
          return json({ ticker: t.toUpperCase(), taken: await isTickerTaken(new Rpc(env.RPC_URL), t) });
        }
        const file = /^\/(m\/[\w-]+\.json|img\/[\w-]+\.(?:png|jpg|webp|gif))$/.exec(p);
        if (file) {
          const obj = await env.FILES.get(file[1]);
          if (!obj) throw new HttpError(404, 'Introuvable');
          const h = new Headers();
          obj.writeHttpMetadata(h);
          h.set('Access-Control-Allow-Origin', '*');
          h.set('X-Content-Type-Options', 'nosniff');
          return new Response(obj.body, { headers: h });
        }
      }
      if (p.startsWith('/api/')) throw new HttpError(405, 'Méthode non autorisée');
      return env.ASSETS.fetch(req);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      return json({ error: status === 500 ? `Erreur serveur : ${(e as Error).message}` : (e as Error).message }, status);
    }
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    // "0 */5 * * *" : relit le n°1 FOMO ; "17 * * * *" : creator fees → SOL
    const path = event.cron.startsWith('0 ') ? '/scan' : '/fees';
    ctx.waitUntil(engineCall(env, path).then((r) => console.log(path, JSON.stringify(r).slice(0, 300))));
  },
} satisfies ExportedHandler<Env>;
