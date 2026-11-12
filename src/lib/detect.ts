/** Détection d'un swap SOL ↔ token dans une transaction jsonParsed, du point de vue d'un trader. */
import { SOL_MINT, USDC_MINT } from './env.js';

export interface Swap { trader: string; mint: string; side: 'buy' | 'sell'; soldFraction: number }

const STABLES = new Set([SOL_MINT, USDC_MINT, 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);

export function detectSwap(tx: any, trader: string, ignore: (mint: string) => boolean = () => false): Swap | null {
  const meta = tx?.meta;
  if (!meta || meta.err) return null;
  const keys: string[] = (tx.transaction?.message?.accountKeys ?? []).map((k: any) => (typeof k === 'string' ? k : k.pubkey?.toString?.() ?? String(k.pubkey)));
  const idx = keys.indexOf(trader);
  if (idx < 0) return null;

  let solDelta = (meta.postBalances[idx] - meta.preBalances[idx]) / 1e9;
  const deltas = new Map<string, { pre: number; post: number }>();
  for (const [list, field] of [[meta.preTokenBalances ?? [], 'pre'], [meta.postTokenBalances ?? [], 'post']] as const) {
    for (const b of list as any[]) {
      if (b.owner !== trader) continue;
      const amt = Number(b.uiTokenAmount?.uiAmount ?? 0);
      if (b.mint === SOL_MINT) { solDelta += field === 'post' ? amt : -amt; continue; }
      const d = deltas.get(b.mint) ?? { pre: 0, post: 0 };
      d[field] += amt;
      deltas.set(b.mint, d);
    }
  }
  let best: { mint: string; pre: number; post: number } | null = null;
  for (const [mint, d] of deltas) {
    if (STABLES.has(mint) || ignore(mint)) continue;
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
