/**
 * Étape 2 — copy-trading des traders du classement FOMO.
 *
 * Le bot écoute on-chain (WebSocket) les transactions des wallets suivis, détecte les swaps
 * (variation de SOL vs variation d'un token) et les réplique via Jupiter avec des garde-fous.
 */
import { PublicKey, LAMPORTS_PER_SOL, ParsedTransactionWithMeta } from '@solana/web3.js';
import { config, SOL_MINT } from './config.js';
import { connection, bot, log, mintInfo, tokenBalanceRaw, solBalance } from './solana.js';
import { getQuote, impactPct, swap } from './jupiter.js';
import { state, save, record, Position } from './state.js';
import { runBuybackIfReady } from './buyback.js';
import { listCoins } from '../registry.js';
import { leaderWallets } from './leaderboard.js';

const IGNORED_MINTS = new Set([
  SOL_MINT,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',  // USDT
]);
/** On ne copy-trade jamais les coins du launchpad (conflit d'intérêts + on les rachète déjà). */
const isOwnCoin = (mint: string) => listCoins().some((c) => c.mint === mint);

const seen = new Set<string>();
const busy = new Set<string>(); // mints en cours de traitement (évite les doubles ordres)

export const activeTraders = () => leaderWallets();

interface Swap { trader: string; mint: string; side: 'buy' | 'sell'; soldFraction: number }

/** Analyse une transaction parsée : le trader a-t-il acheté ou vendu un token contre du SOL ? */
export function detectSwap(tx: ParsedTransactionWithMeta, trader: string): Swap | null {
  const meta = tx.meta;
  if (!meta || meta.err) return null;
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  const idx = keys.indexOf(trader);
  if (idx < 0) return null;

  // SOL natif + WSOL du trader
  let solDelta = (meta.postBalances[idx] - meta.preBalances[idx]) / LAMPORTS_PER_SOL;
  const deltas = new Map<string, { pre: number; post: number }>();
  for (const [list, field] of [[meta.preTokenBalances ?? [], 'pre'], [meta.postTokenBalances ?? [], 'post']] as const) {
    for (const b of list) {
      if (b.owner !== trader) continue;
      const amt = Number(b.uiTokenAmount.uiAmount ?? 0);
      if (b.mint === SOL_MINT) { solDelta += field === 'post' ? amt : -amt; continue; }
      const d = deltas.get(b.mint) ?? { pre: 0, post: 0 };
      d[field] += amt;
      deltas.set(b.mint, d);
    }
  }

  // Le token qui a le plus bougé (hors SOL / stables / notre token)
  let best: { mint: string; pre: number; post: number } | null = null;
  for (const [mint, d] of deltas) {
    if (IGNORED_MINTS.has(mint) || isOwnCoin(mint)) continue;
    if (!best || Math.abs(d.post - d.pre) > Math.abs(best.post - best.pre)) best = { mint, ...d };
  }
  if (!best || best.post === best.pre) return null;

  if (best.post > best.pre && solDelta < -0.001) return { trader, mint: best.mint, side: 'buy', soldFraction: 0 };
  if (best.post < best.pre && solDelta > 0.001) {
    const soldFraction = best.pre > 0 ? Math.min(1, (best.pre - best.post) / best.pre) : 1;
    return { trader, mint: best.mint, side: 'sell', soldFraction };
  }
  return null;
}

async function tradingCapitalSol(): Promise<number> {
  return Math.max(0, (await solBalance(bot().publicKey)) - config.solReserve - state.buybackBucketSol);
}

function rollDay(capital: number) {
  const today = new Date().setUTCHours(0, 0, 0, 0);
  if (state.dayStart !== today) {
    state.dayStart = today;
    state.dayStartCapitalSol = capital;
    state.dayRealizedSol = 0;
    if (state.paused) { state.paused = false; log('Nouveau jour : bot réactivé.'); }
    save();
  }
}

/** Filtres anti-rug sur le token copié. */
async function isSafeToken(mint: PublicKey): Promise<string | null> {
  try {
    const m = await mintInfo(mint);
    if (m.mintAuthority) return 'mint authority active';
    if (m.freezeAuthority) return 'freeze authority active';
    return null;
  } catch (e) {
    return `mint illisible (${(e as Error).message})`;
  }
}

async function copyBuy(s: Swap) {
  if (state.paused) return log('⏸  En pause (perte journalière max atteinte), achat ignoré.');
  if (state.positions[s.mint]) return; // déjà en position
  if (Object.keys(state.positions).length >= config.maxOpenPositions) return log('Max positions atteint, achat ignoré.');

  const capital = await tradingCapitalSol();
  rollDay(capital);
  const sizeSol = (capital * config.maxPositionPct) / 100;
  if (sizeSol < config.minTradeSol) return log(`Capital trop faible (${capital.toFixed(3)} SOL), achat ignoré.`);

  const mint = new PublicKey(s.mint);
  const unsafe = await isSafeToken(mint);
  if (unsafe) return log(`⛔ ${s.mint} rejeté : ${unsafe}`);

  const lamports = BigInt(Math.floor(sizeSol * LAMPORTS_PER_SOL));
  const q = await getQuote(SOL_MINT, s.mint, lamports);
  if (impactPct(q) > config.maxPriceImpactPct) return log(`⛔ ${s.mint} rejeté : impact achat ${impactPct(q).toFixed(2)}%`);
  // Test de sortie : peut-on revendre sans massacre ? (filtre liquidité / honeypot)
  const exitQ = await getQuote(s.mint, SOL_MINT, BigInt(q.outAmount));
  if (impactPct(exitQ) > config.maxPriceImpactPct * 2) return log(`⛔ ${s.mint} rejeté : liquidité de sortie insuffisante`);

  const before = await tokenBalanceRaw(bot().publicKey, mint);
  const { sig, outAmount } = await swap(q, bot(), `copy BUY ${s.mint.slice(0, 6)}`);
  const got = config.dryRun ? outAmount : (await tokenBalanceRaw(bot().publicKey, mint)) - before;

  state.positions[s.mint] = { mint: s.mint, trader: s.trader, amountRaw: got.toString(), costSol: sizeSol, openedAt: Date.now() };
  record('buy', { mint: s.mint, trader: s.trader, sol: sizeSol, sig });
}

/** Vend `fraction` d'une position et réalise le PnL. */
export async function sellPosition(p: Position, fraction: number, reason: string) {
  if (fraction > 0.9) fraction = 1;
  const amount = fraction === 1 ? BigInt(p.amountRaw) : (BigInt(p.amountRaw) * BigInt(Math.floor(fraction * 10_000))) / 10_000n;
  if (amount <= 0n) return;

  const q = await getQuote(p.mint, SOL_MINT, amount);
  const { sig, outAmount } = await swap(q, bot(), `SELL ${p.mint.slice(0, 6)} (${reason})`);
  const solOut = Number(outAmount) / LAMPORTS_PER_SOL;
  const cost = p.costSol * fraction;
  const pnl = solOut - cost;

  state.realizedPnlSol += pnl;
  state.dayRealizedSol += pnl;
  if (pnl > 0) state.buybackBucketSol += (pnl * config.buybackPct) / 100;

  if (fraction === 1) delete state.positions[p.mint];
  else { p.amountRaw = (BigInt(p.amountRaw) - amount).toString(); p.costSol -= cost; }

  record('sell', { mint: p.mint, reason, solOut, pnl, sig });
  log(`${pnl >= 0 ? '✅' : '❌'} ${p.mint.slice(0, 6)} PnL ${pnl.toFixed(4)} SOL (${reason})`);

  if (state.dayStartCapitalSol > 0 && state.dayRealizedSol < -(state.dayStartCapitalSol * config.maxDailyLossPct) / 100) {
    state.paused = true;
    record('pause', { dayRealizedSol: state.dayRealizedSol });
    log('⏸  Perte journalière max atteinte : nouveaux achats suspendus jusqu’à demain (UTC).');
  }
  save();
  await runBuybackIfReady();
}

async function handle(sig: string, trader: string) {
  if (seen.has(sig)) return;
  seen.add(sig);
  if (seen.size > 20_000) seen.clear();

  const tx = await connection.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  if (!tx) return;
  const s = detectSwap(tx, trader);
  if (!s || busy.has(s.mint)) return;
  busy.add(s.mint);
  try {
    log(`👀 ${trader.slice(0, 6)} ${s.side.toUpperCase()} ${s.mint}${s.side === 'sell' ? ` (${(s.soldFraction * 100).toFixed(0)}%)` : ''}`);
    // on n'achète que derrière le n°1 actuel ; un ancien n°1 n'est suivi que pour revendre ses positions
    if (s.side === 'buy') { if (activeTraders().includes(trader)) await copyBuy(s); }
    else {
      const p = state.positions[s.mint];
      if (p && p.trader === trader) await sellPosition(p, s.soldFraction, 'trader vend');
    }
  } catch (e) {
    log(`Erreur copie ${sig}:`, (e as Error).message);
  } finally {
    busy.delete(s.mint);
  }
}

const subs = new Map<string, number>(); // wallet suivi → id d'abonnement WebSocket

/**
 * Met les abonnements à jour : le(s) wallet(s) du n°1 actuel, plus les anciens traders
 * dont on détient encore une position (pour copier leur vente).
 */
export async function refreshWatching() {
  const wanted = new Set([...activeTraders(), ...Object.values(state.positions).map((p) => p.trader)]);
  for (const [w, id] of subs) {
    if (wanted.has(w)) continue;
    await connection.removeOnLogsListener(id).catch(() => {});
    subs.delete(w);
    log(`Fin du suivi de ${w}`);
  }
  for (const w of wanted) {
    if (subs.has(w)) continue;
    let pk: PublicKey;
    try { pk = new PublicKey(w); } catch { log(`Adresse de trader invalide ignorée : ${w}`); continue; }
    subs.set(w, connection.onLogs(pk, (l) => { if (!l.err) void handle(l.signature, w); }, 'confirmed'));
    log(`Suivi du trader ${w}${activeTraders().includes(w) ? '' : ' (ancien n°1, ventes seulement)'}`);
  }
  if (!activeTraders().length) log('⚠️  Aucun trader à copier pour le moment.');
}

export const startWatching = refreshWatching;

/** Stop-loss / take-profit sur les positions ouvertes. */
export async function monitorPositions() {
  for (const p of Object.values(state.positions)) {
    if (busy.has(p.mint)) continue;
    busy.add(p.mint);
    try {
      const q = await getQuote(p.mint, SOL_MINT, BigInt(p.amountRaw));
      const value = Number(q.outAmount) / LAMPORTS_PER_SOL;
      const pct = ((value - p.costSol) / p.costSol) * 100;
      if (pct <= -config.stopLossPct) await sellPosition(p, 1, `stop-loss ${pct.toFixed(0)}%`);
      else if (pct >= config.takeProfitPct) await sellPosition(p, 1, `take-profit +${pct.toFixed(0)}%`);
    } catch (e) {
      log(`Monitor ${p.mint.slice(0, 6)}:`, (e as Error).message);
    } finally {
      busy.delete(p.mint);
    }
  }
}
