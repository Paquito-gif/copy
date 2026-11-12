import 'dotenv/config';

function req(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Variable d'environnement manquante : ${name}`);
  return v;
}
const opt = (name: string, def: string) => process.env[name]?.trim() || def;
const num = (name: string, def: number) => Number(opt(name, String(def)));
const bool = (name: string, def: boolean) => opt(name, String(def)).toLowerCase() === 'true';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

export const config = {
  rpcUrl: req('RPC_URL'),
  wsUrl: process.env.WS_URL?.trim() || undefined,

  /** Wallet PUBLIC du launchpad : fee_receiver de tous les coins + wallet de copy-trading. */
  botSecret: process.env.BOT_PRIVATE_KEY?.trim() || '',
  /** Adresse publique du fee_receiver (suffit pour le serveur web, qui ne signe jamais). */
  feeReceiver: req('FEE_RECEIVER'),

  /**
   * D'où viennent les traders copiés :
   *  - fomo (défaut) : le n°1 du classement FOMO, relu automatiquement toutes les LEADER_SCAN_HOURS ;
   *  - env : la liste fixe TRADERS ci-dessous.
   */
  traderSource: opt('TRADER_SOURCE', 'fomo') as 'fomo' | 'env',
  leaderboardUrl: opt('LEADERBOARD_URL', 'https://api.fomo-api.com/v1/leaderboard'),
  /** Fenêtre du classement : 24h, 7d ou 30d. */
  leaderboardWindow: opt('LEADERBOARD_WINDOW', '24h'),
  /** Clé optionnelle de l'API du classement (sans clé : top 10). */
  fomoApiKey: opt('FOMO_API_KEY', ''),
  leaderScanHours: num('LEADER_SCAN_HOURS', 5),
  /** En mode BASKET : nombre de traders du haut du classement à copier. */
  basketSize: num('BASKET_SIZE', 3),
  /** Traders fixes (TRADER_SOURCE=env, ou secours si le classement est injoignable). */
  traders: opt('TRADERS', '').split(',').map((s) => s.trim()).filter(Boolean),
  mode: opt('MODE', 'TOP1') as 'TOP1' | 'BASKET',
  /** Pseudo du n°1 FOMO affiché sur le site (ex. @pseudo) et lien vers son profil FOMO. */
  traderLabel: opt('TRADER_LABEL', ''),
  traderUrl: opt('TRADER_URL', ''),

  // --- Risque ---
  maxPositionPct: num('MAX_POSITION_PCT', 8),
  maxOpenPositions: num('MAX_OPEN_POSITIONS', 6),
  minTradeSol: num('MIN_TRADE_SOL', 0.05),
  stopLossPct: num('STOP_LOSS_PCT', 35),
  takeProfitPct: num('TAKE_PROFIT_PCT', 150),
  maxDailyLossPct: num('MAX_DAILY_LOSS_PCT', 20),
  maxPriceImpactPct: num('MAX_PRICE_IMPACT_PCT', 3),
  slippageBps: num('SLIPPAGE_BPS', 300),
  solReserve: num('SOL_RESERVE', 0.05),

  // --- Profits ---
  buybackPct: num('BUYBACK_PCT', 80),
  minBuybackSol: num('MIN_BUYBACK_SOL', 0.1),
  /** Montant min. par coin pour un buyback (en dessous, la part attend le cycle suivant). */
  minBuybackPerCoinSol: num('MIN_BUYBACK_PER_COIN_SOL', 0.01),

  // --- Cadence ---
  convertIntervalMin: num('CONVERT_INTERVAL_MIN', 60),
  monitorIntervalSec: num('MONITOR_INTERVAL_SEC', 30),

  jupiterApi: opt('JUPITER_API', 'https://lite-api.jup.ag/swap/v1'),
  priorityFeeLamports: num('PRIORITY_FEE_LAMPORTS', 200_000),

  dryRun: bool('DRY_RUN', true),
  dataDir: opt('DATA_DIR', './data'),

  // --- Site ---
  port: num('PORT', 3000),
  publicUrl: opt('PUBLIC_URL', 'http://localhost:3000').replace(/\/$/, ''),
  siteName: opt('SITE_NAME', 'Copy Launch'),
};

export type Config = typeof config;
