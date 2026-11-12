/** Bindings et variables du Worker (voir wrangler.toml). Les secrets se posent avec `wrangler secret put`. */
export interface Env {
  DB: D1Database;
  FILES: KVNamespace;
  ENGINE: DurableObjectNamespace;
  RL_WRITE?: { limit(o: { key: string }): Promise<{ success: boolean }> }; // POST: uploads, builds, confirms
  RL_READ?: { limit(o: { key: string }): Promise<{ success: boolean }> };  // GET /api/*

  // secrets
  RPC_URL: string;
  PRIVATE_RPC?: string;       // on | off: off = keyed RPCs (e.g. Helius) are skipped to save credits
  BOT_PRIVATE_KEY?: string;   // clé du wallet public (base58) : seul le moteur l'utilise
  ADMIN_TOKEN?: string;       // protège /api/admin/*
  FOMO_API_KEY?: string;

  // variables
  FEE_RECEIVER: string;
  SITE_NAME?: string;
  PUBLIC_URL?: string;
  TRADER_SOURCE?: string;     // fomo | env
  TRADERS?: string;
  MODE?: string;              // TOP1 | BASKET
  BASKET_SIZE?: string;
  LEADERBOARD_URL?: string;
  LEADERBOARD_WINDOW?: string;
  MAX_POSITION_PCT?: string;
  MAX_OPEN_POSITIONS?: string;
  MIN_TRADE_SOL?: string;
  STOP_LOSS_PCT?: string;
  TAKE_PROFIT_PCT?: string;
  MAX_DAILY_LOSS_PCT?: string;
  MAX_PRICE_IMPACT_PCT?: string;
  SLIPPAGE_BPS?: string;
  SOL_RESERVE?: string;
  BUYBACK_PCT?: string;
  MIN_BUYBACK_SOL?: string;
  MIN_BUYBACK_PER_COIN_SOL?: string;
  POLL_SECONDS?: string;
  MONITOR_SECONDS?: string;
  JUPITER_API?: string;
  PRIORITY_FEE_LAMPORTS?: string;
  DRY_RUN?: string;
}

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export function settings(env: Env) {
  const n = (v: string | undefined, d: number) => (v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
  return {
    feeReceiver: env.FEE_RECEIVER,
    siteName: env.SITE_NAME || 'Flomo',
    traderSource: (env.TRADER_SOURCE || 'fomo') as 'fomo' | 'env',
    traders: (env.TRADERS || '').split(',').map((s) => s.trim()).filter(Boolean),
    mode: (env.MODE || 'TOP1') as 'TOP1' | 'BASKET',
    basketSize: n(env.BASKET_SIZE, 3),
    leaderboardUrl: env.LEADERBOARD_URL || 'https://api.fomo-api.com/v1/leaderboard',
    leaderboardWindow: env.LEADERBOARD_WINDOW || '24h',
    fomoApiKey: env.FOMO_API_KEY || '',
    maxPositionPct: n(env.MAX_POSITION_PCT, 8),
    maxOpenPositions: n(env.MAX_OPEN_POSITIONS, 6),
    minTradeSol: n(env.MIN_TRADE_SOL, 0.05),
    stopLossPct: n(env.STOP_LOSS_PCT, 0),   // 0 = off: exits follow the trader
    takeProfitPct: n(env.TAKE_PROFIT_PCT, 0),
    maxDailyLossPct: n(env.MAX_DAILY_LOSS_PCT, 20),
    maxPriceImpactPct: n(env.MAX_PRICE_IMPACT_PCT, 3),
    slippageBps: n(env.SLIPPAGE_BPS, 300),
    solReserve: n(env.SOL_RESERVE, 0.05),
    buybackPct: n(env.BUYBACK_PCT, 80),
    minBuybackSol: n(env.MIN_BUYBACK_SOL, 0.1),
    minBuybackPerCoinSol: n(env.MIN_BUYBACK_PER_COIN_SOL, 0.01),
    pollSeconds: Math.max(5, n(env.POLL_SECONDS, 10)),
    monitorSeconds: Math.max(10, n(env.MONITOR_SECONDS, 30)),
    jupiterApi: env.JUPITER_API || 'https://lite-api.jup.ag/swap/v1',
    priorityFeeLamports: n(env.PRIORITY_FEE_LAMPORTS, 200_000),
    dryRun: (env.DRY_RUN ?? 'true').toLowerCase() !== 'false',
  };
}
export type Settings = ReturnType<typeof settings>;

/** RPC list to use. With PRIVATE_RPC=off, URLs carrying a key (query string or credentials) are left out. */
export function rpcUrl(env: Pick<Env, 'RPC_URL' | 'PRIVATE_RPC'>): string {
  const all = String(env.RPC_URL ?? '').split(',').map((u) => u.trim()).filter(Boolean);
  if ((env.PRIVATE_RPC ?? 'on').toLowerCase() !== 'off') return all.join(',');
  const keyed = (u: string) => { try { const x = new URL(u); return !!x.search || !!x.username || /key|token/i.test(x.pathname); } catch { return true; } };
  const open = all.filter((u) => !keyed(u));
  return (open.length ? open : ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com']).join(',');
}
