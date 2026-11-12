import { VersionedTransaction, type Keypair } from '@solana/web3.js';
import { Buffer } from 'node:buffer';
import type { Settings } from './env.js';
import { Rpc, b64 } from './rpc.js';

export interface Quote { inputMint: string; outputMint: string; inAmount: string; outAmount: string; priceImpactPct: string; [k: string]: unknown }

export async function getQuote(s: Settings, inputMint: string, outputMint: string, amountRaw: bigint): Promise<Quote> {
  const url = new URL(`${s.jupiterApi}/quote`);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', amountRaw.toString());
  url.searchParams.set('slippageBps', String(s.slippageBps));
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Jupiter quote ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as Quote;
}

export const impactPct = (q: Quote) => Math.abs(Number(q.priceImpactPct)) * 100;

/** Exécute un quote. En DRY_RUN, ne fait rien et renvoie le montant du quote. */
export async function swap(s: Settings, rpc: Rpc, q: Quote, signer: Keypair): Promise<{ sig: string | null; outAmount: bigint }> {
  if (s.dryRun) return { sig: null, outAmount: BigInt(q.outAmount) };
  const r = await fetch(`${s.jupiterApi}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: q,
      userPublicKey: signer.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: s.priorityFeeLamports, priorityLevel: 'high' } },
    }),
  });
  if (!r.ok) throw new Error(`Jupiter swap ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const { swapTransaction } = (await r.json()) as { swapTransaction: string };
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([signer]);
  const sig = await rpc.send(b64(tx.serialize()));
  await rpc.confirm(sig);
  return { sig, outAmount: BigInt(q.outAmount) };
}
