/** Moteur : creator fees → SOL → copy-trading du top FOMO → buyback & burn des coins du launchpad. */
import { config } from './config.js';
import { bot, log, solBalance } from './solana.js';
import { feeCycle } from './fees.js';
import { refreshWatching, monitorPositions } from './copytrader.js';
import { scanLeader } from './leaderboard.js';
import { runBuybackIfReady } from './buyback.js';
import { state } from './state.js';
import { listCoins } from '../registry.js';

async function safe(name: string, fn: () => Promise<void>) {
  try { await fn(); } catch (e) { log(`[${name}] erreur :`, (e as Error).message); }
}

async function main() {
  const w = bot();
  log('=== Moteur du launchpad ===');
  log(`Mode ${config.mode} | DRY_RUN=${config.dryRun} | ${listCoins().length} coins`);
  log(`Wallet public ${w.publicKey.toBase58()} (${(await solBalance(w.publicKey)).toFixed(4)} SOL)`);
  log(`Fees cumulés ${state.totalFeesSol.toFixed(4)} SOL | PnL réalisé ${state.realizedPnlSol.toFixed(4)} SOL`);
  if (config.traderSource === 'fomo') {
    log(`Trader copié : n°1 du classement FOMO (${config.leaderboardWindow}), revérifié toutes les ${config.leaderScanHours} h`);
    const leaderCycle = async () => {
      const { changed } = await scanLeader();
      if (changed) await refreshWatching();
    };
    await safe('classement', leaderCycle);
    setInterval(() => safe('classement', leaderCycle), config.leaderScanHours * 3_600_000);
  } else if (!config.traders.length) {
    log('⚠️  TRADERS vide : aucun trader FOMO à copier.');
  }
  await refreshWatching();
  await safe('fees', feeCycle);
  setInterval(() => safe('fees', feeCycle), config.convertIntervalMin * 60_000);
  setInterval(() => safe('monitor', monitorPositions), config.monitorIntervalSec * 1000);
  setInterval(() => safe('buyback', runBuybackIfReady), 10 * 60_000);
}

main().catch((e) => { console.error(e); process.exit(1); });
