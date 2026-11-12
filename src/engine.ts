/**
 * Moteur de copy-trading, en Durable Object (une seule instance, nommée "main").
 *
 * - Alarme toutes les POLL_SECONDS : lit les nouvelles transactions du/des trader(s) suivi(s)
 *   et réplique les achats/ventes via Jupiter ; stop-loss / take-profit ; buyback & burn.
 * - Cron toutes les 5 h → /scan : relit le n°1 du classement FOMO.
 * - Cron toutes les heures → /fees : attribue les creator fees par coin et les convertit en SOL.
 * - En pause par défaut : rien ne tourne avant POST /api/admin/engine {"action":"start"}.
 */
import { DurableObject } from 'cloudflare:workers';
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, type TransactionInstruction } from '@solana/web3.js';
import { createBurnCheckedInstruction, createCloseAccountInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { type Env, type Settings, settings, SOL_MINT, rpcUrl } from './lib/env.js';
import { Rpc, LAMPORTS_PER_SOL, b64 } from './lib/rpc.js';
import { getQuote, impactPct, swap, solPriceUsd } from './lib/jupiter.js';
import { tokenOrigin, type Origin } from './lib/origin.js';
import { detectSwap, type Swap } from './lib/detect.js';
import { fetchLeaderboard, type Leader } from './lib/leaderboard.js';
import { checkFloatConfig, readLaunchState } from './float.js';

export interface Position { mint: string; trader: string; amountRaw: string; costSol: number; openedAt: number }
export interface CoinStats { feesSol: number; buybackSol: number; burnedRaw: string; lastDevShareRaw: string }
export interface EngineEvent { t: number; kind: string; detail: Record<string, unknown> }
export interface EngineState {
  running: boolean;
  positions: Record<string, Position>;
  realizedPnlSol: number;
  buybackBucketSol: number;
  totalFeesSol: number;
  coins: Record<string, CoinStats>;
  dayStart: number; dayStartCapitalSol: number; dayRealizedSol: number; dailyPaused: boolean;
  events: EngineEvent[];
  leader: { current: Leader[]; checkedAt: number; changedAt: number; history: { at: number; handles: string[] }[]; error?: string } | null;
  lastSig: Record<string, string>;
  lastMonitor: number;
  lastError?: string;
}

const empty = (): EngineState => ({
  running: false, positions: {}, realizedPnlSol: 0, buybackBucketSol: 0, totalFeesSol: 0, coins: {},
  dayStart: 0, dayStartCapitalSol: 0, dayRealizedSol: 0, dailyPaused: false, events: [], leader: null,
  lastSig: {}, lastMonitor: 0,
});

export class CopyEngine extends DurableObject<Env> {
  private st: EngineState | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private s: Settings;
  private rpc: Rpc;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.s = settings(env);
    this.rpc = new Rpc(rpcUrl(env));
  }

  // ---------- état ----------
  private async state(): Promise<EngineState> {
    if (!this.st) this.st = { ...empty(), ...((await this.ctx.storage.get<EngineState>('state')) ?? {}) };
    return this.st;
  }
  private async save() { if (this.st) await this.ctx.storage.put('state', this.st); }
  private async record(kind: string, detail: Record<string, unknown>) {
    const st = await this.state();
    st.events.push({ t: Date.now(), kind, detail });
    if (st.events.length > 300) st.events.splice(0, st.events.length - 300);
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }
  private bot(): Keypair {
    if (!this.env.BOT_PRIVATE_KEY) throw new Error('BOT_PRIVATE_KEY manquant');
    const k = Keypair.fromSecretKey(bs58.decode(this.env.BOT_PRIVATE_KEY));
    if (k.publicKey.toBase58() !== this.s.feeReceiver) throw new Error('BOT_PRIVATE_KEY ne correspond pas à FEE_RECEIVER');
    return k;
  }

  // ---------- routes internes (appelées par le Worker) ----------
  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    try {
      if (path === '/state') return Response.json(await this.publicState());
      if (path === '/start') return Response.json(await this.exclusive(() => this.start()));
      if (path === '/pause') return Response.json(await this.exclusive(() => this.pause()));
      if (path === '/scan') return Response.json(await this.exclusive(() => this.scanLeader()));
      if (path === '/fees') return Response.json(await this.exclusive(() => this.feeCycle()));
      return new Response('Not found', { status: 404 });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  private async publicState() {
    const st = await this.state();
    const { lastSig: _l, ...rest } = st;
    return { ...rest, dryRun: this.s.dryRun, mode: this.s.mode, wallets: await this.activeWallets() };
  }

  private async start() {
    this.bot(); // vérifie la clé avant de démarrer
    const st = await this.state();
    st.running = true;
    if (this.s.traderSource === 'fomo' && !st.leader) await this.scanLeader();
    await this.record('start', { dryRun: this.s.dryRun });
    await this.save();
    await this.ctx.storage.setAlarm(Date.now() + 1000);
    return { running: true };
  }

  private async pause() {
    const st = await this.state();
    st.running = false;
    await this.record('pause', { reason: 'manuel' });
    await this.save();
    await this.ctx.storage.deleteAlarm();
    return { running: false };
  }

  async alarm() {
    const st = await this.state();
    if (!st.running) return;
    try {
      await this.exclusive(async () => {
        await this.poll();
        if (Date.now() - st.lastMonitor > this.s.monitorSeconds * 1000) {
          st.lastMonitor = Date.now();
          await this.monitorPositions();
          await this.runBuybackIfReady();
        }
        st.lastError = undefined;
        await this.save();
      });
    } catch (e) {
      st.lastError = (e as Error).message;
      await this.save();
    } finally {
      if (st.running) await this.ctx.storage.setAlarm(Date.now() + this.s.pollSeconds * 1000);
    }
  }

  // ---------- classement FOMO ----------
  private async activeWallets(): Promise<string[]> {
    const st = await this.state();
    if (this.s.traderSource === 'fomo' && st.leader?.current.length) return st.leader.current.flatMap((l) => l.wallets);
    return this.s.mode === 'TOP1' ? this.s.traders.slice(0, 1) : this.s.traders;
  }

  async scanLeader() {
    const st = await this.state();
    if (this.s.traderSource !== 'fomo') return { skipped: 'TRADER_SOURCE=env' };
    try {
      const picked = await fetchLeaderboard(this.s);
      const key = (l: Leader[]) => l.map((x) => `${x.handle}:${x.wallets.join(',')}`).join('|');
      const changed = !st.leader || key(st.leader.current) !== key(picked);
      const now = Date.now();
      st.leader = {
        current: picked,
        checkedAt: now,
        changedAt: changed ? now : st.leader!.changedAt,
        history: changed ? [...(st.leader?.history ?? []), { at: now, handles: picked.map((l) => l.handle) }].slice(-100) : st.leader!.history,
      };
      if (changed) await this.record('leader', { handles: picked.map((l) => l.handle), wallets: picked.flatMap((l) => l.wallets) });
      await this.save();
      return { changed, leader: picked };
    } catch (e) {
      // le classement est injoignable : on garde le dernier n°1 connu
      if (st.leader) st.leader.error = (e as Error).message;
      await this.save();
      return { changed: false, error: (e as Error).message };
    }
  }

  // ---------- suivi des trades ----------
  private async ownCoins(): Promise<Set<string>> {
    const r = await this.env.DB.prepare('SELECT mint FROM coins').all<{ mint: string }>();
    return new Set(r.results.map((c) => c.mint));
  }

  private async poll() {
    const st = await this.state();
    const active = await this.activeWallets();
    const watched = new Set([...active, ...Object.values(st.positions).map((p) => p.trader)]);
    const own = await this.ownCoins();
    for (const wallet of watched) {
      const last = st.lastSig[wallet];
      const sigs = await this.rpc.getSignatures(wallet, { limit: 20, until: last });
      if (!sigs.length) continue;
      st.lastSig[wallet] = sigs[0].signature;
      if (!last) continue; // premier passage : on part de maintenant, on ne rejoue pas l'historique
      for (const sig of sigs.slice().reverse()) {
        if (sig.err) continue;
        const tx = await this.rpc.getParsedTransaction(sig.signature);
        const s = detectSwap(tx, wallet, (m) => own.has(m));
        if (!s) continue;
        await this.record('seen', { trader: wallet, side: s.side, mint: s.mint, sig: sig.signature });
        if (s.side === 'buy') {
          if (!active.includes(wallet)) continue;
          // only memecoins launched on pump.fun or Raydium LaunchLab; everything else is ignored
          const origin = await this.origin(s.mint);
          if (origin === 'other') { await this.record('skip', { mint: s.mint, reason: 'not a pump.fun or Raydium LaunchLab memecoin' }); continue; }
          await this.copyBuy(s);
        }
        else {
          const p = st.positions[s.mint];
          if (p && p.trader === wallet) await this.sellPosition(p, s.soldFraction, 'trader vend');
        }
      }
    }
  }

  /** Token origin, cached in storage (it never changes). */
  private async origin(mint: string): Promise<Origin> {
    const key = `origin:${mint}`;
    const hit = await this.ctx.storage.get<Origin>(key);
    if (hit) return hit;
    const o = await tokenOrigin(this.rpc, mint).catch(() => null);
    if (o) await this.ctx.storage.put(key, o);
    return o ?? 'other';
  }

  private async tradingCapitalSol() {
    const st = await this.state();
    const bal = (await this.rpc.getBalance(this.s.feeReceiver)) / LAMPORTS_PER_SOL;
    return Math.max(0, bal - this.s.solReserve - st.buybackBucketSol);
  }

  private async rollDay(capital: number) {
    const st = await this.state();
    const today = new Date().setUTCHours(0, 0, 0, 0);
    if (st.dayStart !== today) { st.dayStart = today; st.dayStartCapitalSol = capital; st.dayRealizedSol = 0; st.dailyPaused = false; }
  }

  private async copyBuy(s: Swap) {
    const st = await this.state();
    if (st.dailyPaused || st.positions[s.mint]) return;
    // optional hard cap; 0 = none: the wallet balance decides how many positions fit
    if (this.s.maxOpenPositions > 0 && Object.keys(st.positions).length >= this.s.maxOpenPositions) return;
    const capital = await this.tradingCapitalSol();
    await this.rollDay(capital);
    // size: a share of the capital, never more than MAX_TRADE_USD
    const price = await solPriceUsd();
    if (!price) { await this.record('skip', { mint: s.mint, reason: 'SOL price unavailable, $ cap cannot be enforced' }); return; }
    // size from the whole wallet (free SOL + what's already in open positions), so every position is the same size
    const invested = Object.values(st.positions).reduce((a, p) => a + p.costSol, 0);
    const sizeSol = Math.min(((capital + invested) * this.s.maxPositionPct) / 100, this.s.maxTradeUsd / price);
    if (capital < sizeSol) {
      await this.record('skip', { mint: s.mint, reason: `balance too low for a full position: ${capital.toFixed(3)} SOL free, ${sizeSol.toFixed(3)} SOL needed (${Object.keys(st.positions).length} open)` });
      return;
    }
    if (sizeSol < this.s.minTradeSol) { await this.record('skip', { mint: s.mint, reason: `capital ${capital.toFixed(3)} SOL trop faible` }); return; }

    const m = await this.rpc.mintInfo(s.mint).catch(() => null);
    if (!m) return this.record('skip', { mint: s.mint, reason: 'mint illisible' });
    if (m.mintAuthority) return this.record('skip', { mint: s.mint, reason: 'mint authority active' });
    if (m.freezeAuthority) return this.record('skip', { mint: s.mint, reason: 'freeze authority active' });

    const q = await getQuote(this.s, SOL_MINT, s.mint, BigInt(Math.floor(sizeSol * LAMPORTS_PER_SOL)));
    if (impactPct(q) > this.s.maxPriceImpactPct) return this.record('skip', { mint: s.mint, reason: `impact ${impactPct(q).toFixed(2)} %` });
    const exitQ = await getQuote(this.s, s.mint, SOL_MINT, BigInt(q.outAmount));
    if (impactPct(exitQ) > this.s.maxPriceImpactPct * 2) return this.record('skip', { mint: s.mint, reason: 'liquidité de sortie insuffisante' });

    const bot = this.bot();
    const before = this.s.dryRun ? 0n : await this.rpc.tokenBalanceRaw(this.s.feeReceiver, s.mint);
    const { sig, outAmount } = await swap(this.s, this.rpc, q, bot);
    const got = this.s.dryRun ? outAmount : (await this.rpc.tokenBalanceRaw(this.s.feeReceiver, s.mint)) - before;
    st.positions[s.mint] = { mint: s.mint, trader: s.trader, amountRaw: got.toString(), costSol: sizeSol, openedAt: Date.now() };
    await this.record('buy', { mint: s.mint, trader: s.trader, sol: sizeSol, usd: Math.round(sizeSol * price * 100) / 100, sig });
  }

  private async sellPosition(p: Position, fraction: number, reason: string) {
    const st = await this.state();
    if (fraction > 0.9) fraction = 1;
    const amount = fraction === 1 ? BigInt(p.amountRaw) : (BigInt(p.amountRaw) * BigInt(Math.floor(fraction * 10_000))) / 10_000n;
    if (amount <= 0n) return;
    const q = await getQuote(this.s, p.mint, SOL_MINT, amount);
    const { sig, outAmount } = await swap(this.s, this.rpc, q, this.bot());
    const solOut = Number(outAmount) / LAMPORTS_PER_SOL;
    const cost = p.costSol * fraction;
    const pnl = solOut - cost;
    st.realizedPnlSol += pnl;
    st.dayRealizedSol += pnl;
    if (pnl > 0) st.buybackBucketSol += (pnl * this.s.buybackPct) / 100;
    if (fraction === 1) delete st.positions[p.mint];
    else { p.amountRaw = (BigInt(p.amountRaw) - amount).toString(); p.costSol -= cost; }
    await this.record('sell', { mint: p.mint, reason, solOut, pnl, sig });
    if (st.dayStartCapitalSol > 0 && st.dayRealizedSol < -(st.dayStartCapitalSol * this.s.maxDailyLossPct) / 100) {
      st.dailyPaused = true;
      await this.record('pause', { reason: 'perte journalière max', dayRealizedSol: st.dayRealizedSol });
    }
  }

  private async monitorPositions() {
    const sl = this.s.stopLossPct, tp = this.s.takeProfitPct;
    if (sl <= 0 && tp <= 0) return; // exits follow the trader only: no quotes, no requests
    const st = await this.state();
    for (const p of Object.values(st.positions)) {
      try {
        const q = await getQuote(this.s, p.mint, SOL_MINT, BigInt(p.amountRaw));
        const pct = ((Number(q.outAmount) / LAMPORTS_PER_SOL - p.costSol) / p.costSol) * 100;
        if (sl > 0 && pct <= -sl) await this.sellPosition(p, 1, `stop-loss ${pct.toFixed(0)} %`);
        else if (tp > 0 && pct >= tp) await this.sellPosition(p, 1, `take-profit +${pct.toFixed(0)} %`);
      } catch { /* pas de route pour l'instant : on réessaie au prochain tour */ }
    }
  }

  // ---------- transactions simples (burn, unwrap) ----------
  private async sendIxs(ixs: TransactionInstruction[]): Promise<string> {
    const bot = this.bot();
    const { blockhash } = await this.rpc.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: bot.publicKey, recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }), ...ixs],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([bot]);
    const sig = await this.rpc.send(b64(tx.serialize()));
    await this.rpc.confirm(sig);
    return sig;
  }

  private async burn(mint: string, amountRaw: bigint): Promise<string | null> {
    if (amountRaw <= 0n || this.s.dryRun) return null;
    const m = await this.rpc.mintInfo(mint);
    const program = new PublicKey(m.program);
    const owner = new PublicKey(this.s.feeReceiver);
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), owner, false, program);
    return this.sendIxs([createBurnCheckedInstruction(ata, new PublicKey(mint), owner, amountRaw, m.decimals, [], program)]);
  }

  // ---------- buyback & burn ----------
  private async runBuybackIfReady() {
    const st = await this.state();
    if (st.buybackBucketSol < this.s.minBuybackSol || st.totalFeesSol <= 0) return;
    const coins = await this.env.DB.prepare('SELECT mint, ticker FROM coins').all<{ mint: string; ticker: string }>();
    const bucket = st.buybackBucketSol;
    let spent = 0;
    for (const c of coins.results) {
      const cs = st.coins[c.mint];
      if (!cs || cs.feesSol <= 0) continue;
      const share = (bucket * cs.feesSol) / st.totalFeesSol;
      if (share < this.s.minBuybackPerCoinSol) continue;
      try {
        const before = this.s.dryRun ? 0n : await this.rpc.tokenBalanceRaw(this.s.feeReceiver, c.mint);
        const q = await getQuote(this.s, SOL_MINT, c.mint, BigInt(Math.floor(share * LAMPORTS_PER_SOL)));
        const { sig, outAmount } = await swap(this.s, this.rpc, q, this.bot());
        const received = this.s.dryRun ? outAmount : (await this.rpc.tokenBalanceRaw(this.s.feeReceiver, c.mint)) - before;
        const burnSig = await this.burn(c.mint, received);
        cs.buybackSol += share;
        cs.burnedRaw = (BigInt(cs.burnedRaw) + received).toString();
        spent += share;
        await this.record('buyback', { mint: c.mint, ticker: c.ticker, sol: share, sig });
        await this.record('burn', { mint: c.mint, ticker: c.ticker, amountRaw: received.toString(), sig: burnSig });
      } catch (e) {
        await this.record('skip', { mint: c.mint, reason: `buyback reporté : ${(e as Error).message}` });
      }
    }
    st.buybackBucketSol = Math.max(0, bucket - spent);
  }

  // ---------- creator fees ----------
  private async valueInSol(mint: string, raw: bigint): Promise<number> {
    if (raw <= 0n) return 0;
    if (mint === SOL_MINT) return Number(raw) / LAMPORTS_PER_SOL;
    try { return Number((await getQuote(this.s, mint, SOL_MINT, raw)).outAmount) / LAMPORTS_PER_SOL; } catch { return 0; }
  }

  async feeCycle() {
    const st = await this.state();
    const coins = await this.env.DB.prepare('SELECT mint, ticker, quote_mint FROM coins').all<{ mint: string; ticker: string; quote_mint: string }>();
    // 1) attribution : part créateur accumulée par coin, lue on-chain
    const cfg = await checkFloatConfig(this.rpc);
    const creator = BigInt(cfg.split.creator);
    const coinShare = BigInt(cfg.split.holders + cfg.split.creator);
    for (const c of coins.results) {
      try {
        const ls = await readLaunchState(this.rpc, new PublicKey(c.mint));
        if (!ls || ls.feeReceiver !== this.s.feeReceiver) continue;
        const devShare = (ls.coinFeesClaimed * creator) / coinShare;
        const cs = (st.coins[c.mint] ??= { feesSol: 0, buybackSol: 0, burnedRaw: '0', lastDevShareRaw: '0' });
        const delta = devShare - BigInt(cs.lastDevShareRaw);
        if (delta <= 0n) continue;
        const sol = await this.valueInSol(ls.quoteMint, delta);
        cs.lastDevShareRaw = devShare.toString();
        cs.feesSol += sol;
        st.totalFeesSol += sol;
      } catch { /* ce coin sera repris au prochain cycle */ }
    }
    // 2) conversion des rewards reçus en SOL
    const converted: string[] = [];
    if (st.running) {
      for (const mint of new Set(coins.results.map((c) => c.quote_mint))) {
        try {
          const bal = await this.rpc.tokenBalanceRaw(this.s.feeReceiver, mint);
          if (bal === 0n) continue;
          if (mint === SOL_MINT) {
            if (this.s.dryRun) continue;
            const owner = new PublicKey(this.s.feeReceiver);
            const ata = getAssociatedTokenAddressSync(new PublicKey(SOL_MINT), owner, false, TOKEN_PROGRAM_ID);
            const sig = await this.sendIxs([createCloseAccountInstruction(ata, owner, owner)]);
            await this.record('convert', { mint, amountRaw: bal.toString(), sig });
          } else {
            const q = await getQuote(this.s, mint, SOL_MINT, bal);
            if (BigInt(q.outAmount) < 1_000_000n) continue;
            const { sig } = await swap(this.s, this.rpc, q, this.bot());
            await this.record('convert', { mint, amountRaw: bal.toString(), solOut: q.outAmount, sig });
          }
          converted.push(mint);
        } catch (e) {
          await this.record('skip', { mint, reason: `conversion en attente : ${(e as Error).message}` });
        }
      }
    }
    await this.save();
    return { coins: coins.results.length, totalFeesSol: st.totalFeesSol, converted };
  }
}
