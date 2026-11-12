/**
 * Client minimal du programme Float (launchpad Solana sur Raydium LaunchLab).
 *
 * Float n'a pas d'IDL publique. Le format ci-dessous a été vérifié contre des lancements
 * finalisés sur mainnet (novembre 2026) : 23 comptes, discriminator `launch`, et
 * `fee_receiver` passé dans les données de l'instruction (il n'a pas besoin d'être le créateur).
 * Float peut mettre à jour son programme : `checkFloatConfig()` doit passer avant chaque lancement.
 */
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { Buffer } from 'node:buffer';
import type { Rpc } from './lib/rpc.js';

export const FLOAT_PROGRAM = new PublicKey('3KguFi7YYzLgttG46fRism16CfcuNCkDh6U7td9JTqxX');
export const LAUNCHLAB_PROGRAM = new PublicKey('LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj');
export const FLOAT_CONFIG = new PublicKey('AgaKFP4SfEeeM4r4GcSWBwpEAbfHh7wLkJGHqpWrLBQV');
export const FLOAT_TREASURY = new PublicKey('2LMWFmbGBfw78ZEas2NFmAYfo4bhyBqYboYh9nk3mDFQ');
export const FLOAT_FLAGSHIP_MINT = new PublicKey('Bv1a7cEj5aRnJQhMw4kRQqAFesMSd5LwcDnUzq52BMmr');

const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const METADATA = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const SYSTEM = new PublicKey('11111111111111111111111111111111');
const RENT = new PublicKey('SysvarRent111111111111111111111111111111111');

const DISC_LAUNCH = Buffer.from('99f15de116454a3d', 'hex');
const DISC_LAUNCH_STATE = Buffer.from('be958e9713c48564', 'hex');
const DISC_CONFIG = Buffer.from('9b0caae01efacc82', 'hex');
const DISC_QUOTE_ASSET_OWNER = FLOAT_PROGRAM; // un quote activé = compte `quote` détenu par Float

/** Frais affichés par Float pour chaque palier (fee Float + 0,25 % Raydium). */
export const FEE_TIERS = [
  { tier: 0, label: '1 %', floatRate: 7500n },
  { tier: 1, label: '2 %', floatRate: 17500n },
  { tier: 2, label: '2,5 %', floatRate: 22500n },
] as const;

const seed = (s: string) => Buffer.from(s);
const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, program)[0];
const u64le = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
function borshString(v: string) {
  const bytes = Buffer.from(v, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  return Buffer.concat([len, bytes]);
}

export const derive = {
  mint: (creator: PublicKey, nonce: bigint) => pda([seed('mint'), creator.toBuffer(), u64le(nonce)], FLOAT_PROGRAM),
  launch: (mint: PublicKey) => pda([seed('launch'), mint.toBuffer()], FLOAT_PROGRAM),
  coinVault: (mint: PublicKey) => pda([seed('coin'), mint.toBuffer()], FLOAT_PROGRAM),
  quoteAsset: (quote: PublicKey) => pda([seed('quote'), quote.toBuffer()], FLOAT_PROGRAM),
  ticker: (ticker: string) => pda([seed('ticker'), seed(ticker.toUpperCase())], FLOAT_PROGRAM),
  platform: (tier: number) => pda([seed('platform'), Buffer.from([tier])], FLOAT_PROGRAM),
  platformConfig: (tier: number) => pda([seed('platform_config'), derive.platform(tier).toBuffer()], LAUNCHLAB_PROGRAM),
  globalConfig: (quote: PublicKey) =>
    pda([seed('global_config'), quote.toBuffer(), Buffer.from([0]), Buffer.from([0, 0])], LAUNCHLAB_PROGRAM),
  pool: (mint: PublicKey, quote: PublicKey) => pda([seed('pool'), mint.toBuffer(), quote.toBuffer()], LAUNCHLAB_PROGRAM),
  poolVault: (pool: PublicKey, mint: PublicKey) => pda([seed('pool_vault'), pool.toBuffer(), mint.toBuffer()], LAUNCHLAB_PROGRAM),
  launchlabAuthority: () => pda([seed('vault_auth_seed')], LAUNCHLAB_PROGRAM),
  eventAuthority: () => pda([seed('__event_authority')], LAUNCHLAB_PROGRAM),
  metadata: (mint: PublicKey) => pda([seed('metadata'), METADATA.toBuffer(), mint.toBuffer()], METADATA),
};

export interface LaunchParams {
  creator: PublicKey;        // wallet de l'utilisateur, signe et paie le lancement
  feeReceiver: PublicKey;    // wallet public de copy-trading du launchpad
  name: string;
  ticker: string;
  uri: string;               // JSON de métadonnées (hébergé par le launchpad)
  quoteMint: PublicKey;      // SOL (wSOL), USDC ou action tokenisée activée sur Float
  quoteTokenProgram: PublicKey;
  tier: 0 | 1 | 2;
  nonce: bigint;
}

export function validateLaunch(p: Pick<LaunchParams, 'name' | 'ticker' | 'uri' | 'tier'>) {
  if (!/^[A-Za-z0-9]{1,10}$/.test(p.ticker)) throw new Error('Ticker : 1 à 10 lettres ou chiffres');
  const n = Buffer.byteLength(p.name.trim(), 'utf8');
  if (n < 1 || n > 32) throw new Error('Nom : 1 à 32 caractères');
  if (Buffer.byteLength(p.uri, 'utf8') > 200) throw new Error('URI de métadonnées trop longue');
  if (![0, 1, 2].includes(p.tier)) throw new Error('Palier de fees invalide');
}

export function buildLaunchIx(p: LaunchParams): { ix: TransactionInstruction; mint: PublicKey; launch: PublicKey } {
  validateLaunch(p);
  if (!p.quoteTokenProgram.equals(TOKEN) && !p.quoteTokenProgram.equals(TOKEN_2022)) {
    throw new Error('Programme token du quote non supporté');
  }
  const mint = derive.mint(p.creator, p.nonce);
  const pool = derive.pool(mint, p.quoteMint);
  const launch = derive.launch(mint);

  const keys: [PublicKey, boolean, boolean][] = [
    [p.creator, true, true],
    [FLOAT_CONFIG, false, false],
    [FLOAT_TREASURY, false, true],
    [derive.quoteAsset(p.quoteMint), false, false],
    [p.quoteMint, false, false],
    [derive.ticker(p.ticker), false, true],
    [mint, false, true],
    [launch, false, true],
    [derive.coinVault(mint), false, false],
    [derive.globalConfig(p.quoteMint), false, false],
    [derive.platformConfig(p.tier), false, false],
    [derive.launchlabAuthority(), false, false],
    [pool, false, true],
    [derive.poolVault(pool, mint), false, true],
    [derive.poolVault(pool, p.quoteMint), false, true],
    [derive.metadata(mint), false, true],
    [derive.eventAuthority(), false, false],
    [LAUNCHLAB_PROGRAM, false, false],
    [TOKEN, false, false],
    [p.quoteTokenProgram, false, false],
    [METADATA, false, false],
    [SYSTEM, false, false],
    [RENT, false, false],
  ];

  const data = Buffer.concat([
    DISC_LAUNCH,
    borshString(p.name.trim()),
    borshString(p.ticker),
    borshString(p.uri),
    p.feeReceiver.toBuffer(),
    Buffer.from([p.tier]),
    u64le(p.nonce),
    u64le(0n), // champ ajouté par la mise à jour du programme de nov. 2026 ; toujours 0 dans les lancements observés
  ]);

  return {
    ix: new TransactionInstruction({
      programId: FLOAT_PROGRAM,
      keys: keys.map(([pubkey, isSigner, isWritable]) => ({ pubkey, isSigner, isWritable })),
      data,
    }),
    mint,
    launch,
  };
}

export interface FloatConfig {
  split: { holders: number; creator: number; flagship: number; traders: number; treasury: number };
  tierRates: bigint[];
  platforms: string[];
  launchesPaused: boolean;
}

export function decodeConfig(d: Buffer): FloatConfig {
  if (d.length < 272 || !d.subarray(0, 8).equals(DISC_CONFIG)) throw new Error('Compte config Float inattendu');
  const s = (i: number) => d.readUInt16LE(72 + i * 2);
  return {
    split: { holders: s(0), creator: s(1), flagship: s(2), traders: s(3), treasury: s(4) },
    tierRates: [0, 1, 2].map((i) => d.readBigUInt64LE(82 + i * 8)),
    platforms: [0, 1, 2].map((i) => new PublicKey(d.subarray(107 + i * 32, 139 + i * 32)).toBase58()),
    launchesPaused: d[271] === 1,
  };
}

/** Vérifie que Float accepte les lancements et que nos dérivations correspondent toujours à la config on-chain. */
export async function checkFloatConfig(rpc: Rpc): Promise<FloatConfig> {
  const acc = await rpc.getAccountInfo(FLOAT_CONFIG.toBase58());
  if (!acc || acc.owner !== FLOAT_PROGRAM.toBase58()) throw new Error('Config Float introuvable');
  const cfg = decodeConfig(Buffer.from(acc.data));
  if (cfg.launchesPaused) throw new Error('Float a mis les lancements en pause');
  for (const t of [0, 1, 2]) {
    if (cfg.platforms[t] !== derive.platformConfig(t).toBase58()) {
      throw new Error('Le programme Float a changé (platform config). Mise à jour du launchpad nécessaire.');
    }
  }
  if (cfg.split.creator === 0) throw new Error('Float ne verse plus de part créateur');
  return cfg;
}

export interface LaunchState {
  creator: string; feeReceiver: string; coinMint: string; quoteMint: string; pool: string;
  feeTier: number; createdAt: bigint; coinFeesClaimed: bigint; holderRewards: bigint;
  holderRewardsPaid: bigint; devOwed: bigint;
}

export function decodeLaunchState(d: Buffer): LaunchState {
  if (d.length < 210 || !d.subarray(0, 8).equals(DISC_LAUNCH_STATE)) throw new Error('Pas un compte LaunchState Float');
  let o = 8;
  const pk = () => { const k = new PublicKey(d.subarray(o, o + 32)).toBase58(); o += 32; return k; };
  const creator = pk(), feeReceiver = pk(), coinMint = pk(), quoteMint = pk(), pool = pk();
  const feeTier = d[o]; o += 1;
  const createdAt = d.readBigInt64LE(o); o += 8;
  const u = () => { const v = d.readBigUInt64LE(o); o += 8; return v; };
  return { creator, feeReceiver, coinMint, quoteMint, pool, feeTier, createdAt,
    coinFeesClaimed: u(), holderRewards: u(), holderRewardsPaid: u(), devOwed: u() };
}

export async function readLaunchState(rpc: Rpc, mint: PublicKey): Promise<LaunchState | null> {
  const acc = await rpc.getAccountInfo(derive.launch(mint).toBase58());
  if (!acc || acc.owner !== FLOAT_PROGRAM.toBase58()) return null;
  return decodeLaunchState(Buffer.from(acc.data));
}

/** Un quote est lançable seulement si Float l'a activé (compte `quote` existant). */
export async function isQuoteEnabled(rpc: Rpc, quote: PublicKey): Promise<boolean> {
  const acc = await rpc.getAccountInfo(derive.quoteAsset(quote).toBase58());
  return !!acc && acc.owner === DISC_QUOTE_ASSET_OWNER.toBase58();
}

export async function isTickerTaken(rpc: Rpc, ticker: string): Promise<boolean> {
  return !!(await rpc.getAccountInfo(derive.ticker(ticker).toBase58()));
}

export const TOKEN_PROGRAMS = { TOKEN, TOKEN_2022 };
