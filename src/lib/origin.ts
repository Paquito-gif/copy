/**
 * Where a token was born. The copy engine only copies buys of memecoins launched on
 * pump.fun or on Raydium LaunchLab (Bonk, Float…), whatever venue the trader used to buy them.
 * One getMultipleAccounts call: the launchpad's own account for that mint exists or it doesn't.
 */
import { PublicKey } from '@solana/web3.js';
import { derive } from '../float.js';
import { SOL_MINT, USDC_MINT } from './env.js';
import type { Rpc } from './rpc.js';

export type Origin = 'pumpfun' | 'launchlab' | 'other';

const PUMP_FUN = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const LAUNCHLAB = new PublicKey('LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj');
const USD1_MINT = 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB'; // quote used by Bonk launches

export async function tokenOrigin(rpc: Rpc, mint: string): Promise<Origin> {
  const m = new PublicKey(mint);
  const curve = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), m.toBuffer()], PUMP_FUN)[0];
  const pools = [SOL_MINT, USDC_MINT, USD1_MINT].map((q) => derive.pool(m, new PublicKey(q)));
  const accs = await rpc.getMultipleAccounts([curve, ...pools].map((k) => k.toBase58()));
  // the account must belong to the launchpad program and hold data: anyone can send lamports to any address
  const real = (a: (typeof accs)[number], program: PublicKey) => !!a && a.owner === program.toBase58() && a.data.length > 40;
  if (real(accs[0], PUMP_FUN)) return 'pumpfun';
  if (accs.slice(1).some((a) => real(a, LAUNCHLAB))) return 'launchlab';
  return 'other';
}
