/**
 * Étape 3 — buyback & burn, réparti entre les coins du launchpad.
 * Chaque coin reçoit une part des profits proportionnelle aux fees qu'il a générés :
 * plus un coin fait de volume, plus il est racheté et brûlé.
 */
import { Keypair, PublicKey, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createBurnCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { config, SOL_MINT } from './config.js';
import { connection, bot, log, mintInfo, tokenBalanceRaw } from './solana.js';
import { getQuote, swap } from './jupiter.js';
import { state, record, save, coinStats } from './state.js';
import { listCoins } from '../registry.js';

export async function burn(owner: Keypair, mint: PublicKey, amountRaw: bigint, label: string): Promise<string | null> {
  if (amountRaw <= 0n) return null;
  const m = await mintInfo(mint);
  const ata = getAssociatedTokenAddressSync(mint, owner.publicKey, false, m.program);
  if (config.dryRun) { log(`[DRY_RUN] burn ${amountRaw} ${label}`); return null; }
  const tx = new Transaction().add(createBurnCheckedInstruction(ata, mint, owner.publicKey, amountRaw, m.decimals, [], m.program));
  const sig = await sendAndConfirmTransaction(connection, tx, [owner]);
  log(`🔥 Burn ${amountRaw} ${label}: https://solscan.io/tx/${sig}`);
  return sig;
}

async function buybackCoin(mint: string, ticker: string, sol: number) {
  const owner = bot();
  const pk = new PublicKey(mint);
  const before = await tokenBalanceRaw(owner.publicKey, pk);
  const q = await getQuote(SOL_MINT, mint, BigInt(Math.floor(sol * LAMPORTS_PER_SOL)));
  const { sig, outAmount } = await swap(q, owner, `buyback ${ticker}`);
  const received = config.dryRun ? outAmount : (await tokenBalanceRaw(owner.publicKey, pk)) - before;
  const burnSig = await burn(owner, pk, received, ticker);

  const st = coinStats(mint);
  st.buybackSol += sol;
  st.burnedRaw = (BigInt(st.burnedRaw) + received).toString();
  record('buyback', { mint, ticker, sol, sig });
  record('burn', { mint, ticker, amountRaw: received.toString(), sig: burnSig });
}

export async function runBuybackIfReady() {
  if (state.buybackBucketSol < config.minBuybackSol || state.totalFeesSol <= 0) return;
  const bucket = state.buybackBucketSol;
  let spent = 0;

  for (const coin of listCoins()) {
    const st = state.coins[coin.mint];
    if (!st || st.feesSol <= 0) continue;
    const share = (bucket * st.feesSol) / state.totalFeesSol;
    if (share < config.minBuybackPerCoinSol) continue; // reste dans le bucket pour plus tard
    try {
      await buybackCoin(coin.mint, coin.ticker, share);
      spent += share;
    } catch (e) {
      log(`Buyback ${coin.ticker} reporté :`, (e as Error).message);
    }
  }
  state.buybackBucketSol = Math.max(0, bucket - spent);
  save();
}
