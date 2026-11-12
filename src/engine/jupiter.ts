import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { config } from './config.js';
import { log, sendVersioned } from './solana.js';

export interface Quote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  [k: string]: unknown;
}

export async function getQuote(inputMint: string, outputMint: string, amountRaw: bigint): Promise<Quote> {
  const url = new URL(`${config.jupiterApi}/quote`);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', amountRaw.toString());
  url.searchParams.set('slippageBps', String(config.slippageBps));
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Jupiter quote ${r.status}: ${await r.text()}`);
  return (await r.json()) as Quote;
}

export const impactPct = (q: Quote) => Math.abs(Number(q.priceImpactPct)) * 100;

/** Exécute un quote Jupiter. En DRY_RUN, renvoie juste le quote sans envoyer. */
export async function swap(q: Quote, signer: Keypair, label: string): Promise<{ sig: string | null; outAmount: bigint }> {
  if (config.dryRun) {
    log(`[DRY_RUN] swap ${label}: ${q.inAmount} ${q.inputMint.slice(0, 4)}… → ${q.outAmount} ${q.outputMint.slice(0, 4)}…`);
    return { sig: null, outAmount: BigInt(q.outAmount) };
  }
  const r = await fetch(`${config.jupiterApi}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: q,
      userPublicKey: signer.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { maxLamports: config.priorityFeeLamports, priorityLevel: 'high' },
      },
    }),
  });
  if (!r.ok) throw new Error(`Jupiter swap ${r.status}: ${await r.text()}`);
  const { swapTransaction } = (await r.json()) as { swapTransaction: string };
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  const sig = await sendVersioned(tx, signer);
  log(`swap ${label} OK: https://solscan.io/tx/${sig}`);
  return { sig, outAmount: BigInt(q.outAmount) };
}
