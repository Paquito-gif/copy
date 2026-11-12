/**
 * Étape 1 — les creator fees de tous les coins du launchpad financent le wallet de copy-trading.
 *
 * Chaque coin est lancé sur Float avec `fee_receiver` = le wallet public du launchpad.
 * Float verse la part créateur (5 % de ses fees, à vérifier dans la config on-chain) dans
 * l'actif de paire de chaque coin, via `claim_dev_fees` (crank permissionless de Float).
 *
 * Ce module :
 *  1. attribue les nouveaux fees à chaque coin (lecture du LaunchState on-chain) → sert
 *     à répartir les buybacks au prorata ;
 *  2. convertit en SOL tout ce qui est arrivé (wSOL déballé, USDC/actions swappés via Jupiter).
 */
import { PublicKey, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createCloseAccountInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { config, SOL_MINT } from './config.js';
import { connection, bot, log, tokenBalanceRaw } from './solana.js';
import { getQuote, swap } from './jupiter.js';
import { state, save, record, coinStats } from './state.js';
import { listCoins } from '../registry.js';
import { readLaunchState, checkFloatConfig } from '../float.js';

/** Valeur en SOL d'un montant brut d'un token (0 si pas de route). */
async function valueInSol(mint: string, raw: bigint): Promise<number> {
  if (raw <= 0n) return 0;
  if (mint === SOL_MINT) return Number(raw) / LAMPORTS_PER_SOL;
  try {
    const q = await getQuote(mint, SOL_MINT, raw);
    return Number(q.outAmount) / LAMPORTS_PER_SOL;
  } catch {
    return 0;
  }
}

/** Attribue à chaque coin la part créateur accumulée depuis le dernier cycle. */
export async function attributeFees() {
  const cfg = await checkFloatConfig(connection);
  const creatorShare = BigInt(cfg.split.creator);
  const coinShare = BigInt(cfg.split.holders + cfg.split.creator);
  for (const coin of listCoins()) {
    try {
      const ls = await readLaunchState(connection, new PublicKey(coin.mint));
      if (!ls || ls.feeReceiver !== config.feeReceiver) continue;
      // `coin_fees_claimed` = parts holders + créateur collectées pour ce coin.
      const devShare = (ls.coinFeesClaimed * creatorShare) / coinShare;
      const st = coinStats(coin.mint);
      const delta = devShare - BigInt(st.lastDevShareRaw);
      if (delta <= 0n) continue;
      const sol = await valueInSol(ls.quoteMint, delta);
      st.lastDevShareRaw = devShare.toString();
      st.feesSol += sol;
      state.totalFeesSol += sol;
      log(`Fees ${coin.ticker}: +${sol.toFixed(5)} SOL`);
    } catch (e) {
      log(`Attribution ${coin.ticker} :`, (e as Error).message);
    }
  }
  save();
}

/** Convertit en SOL tous les rewards reçus par le wallet (un mint par actif de paire). */
export async function convertRewards() {
  const owner = bot();
  const quoteMints = new Set(listCoins().map((c) => c.quoteMint));

  for (const mint of quoteMints) {
    try {
      if (mint === SOL_MINT) {
        // wSOL → SOL : fermer le compte wSOL suffit à le déballer.
        const ata = getAssociatedTokenAddressSync(new PublicKey(SOL_MINT), owner.publicKey, false, TOKEN_PROGRAM_ID);
        const acc = await connection.getAccountInfo(ata);
        if (!acc) continue;
        const bal = await tokenBalanceRaw(owner.publicKey, new PublicKey(SOL_MINT));
        if (bal === 0n) continue;
        if (config.dryRun) { log(`[DRY_RUN] unwrap ${Number(bal) / 1e9} wSOL`); continue; }
        const tx = new Transaction().add(createCloseAccountInstruction(ata, owner.publicKey, owner.publicKey));
        const sig = await sendAndConfirmTransaction(connection, tx, [owner]);
        record('convert', { mint, amountRaw: bal.toString(), sig });
        continue;
      }
      const bal = await tokenBalanceRaw(owner.publicKey, new PublicKey(mint));
      if (bal === 0n) continue;
      const q = await getQuote(mint, SOL_MINT, bal);
      if (BigInt(q.outAmount) < 1_000_000n) continue; // < 0,001 SOL : on attend d'en avoir plus
      const { sig } = await swap(q, owner, `rewards ${mint.slice(0, 4)}…→SOL`);
      record('convert', { mint, amountRaw: bal.toString(), solOut: q.outAmount, sig });
    } catch (e) {
      // Ex. action tokenisée sans route vers SOL : le reward reste en attente dans le wallet.
      log(`Conversion ${mint.slice(0, 4)}… en attente :`, (e as Error).message);
    }
  }
}

export async function feeCycle() {
  await attributeFees();
  await convertRewards();
}
