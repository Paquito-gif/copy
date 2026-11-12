/**
 * Classement FOMO → trader(s) à copier. fomo.family n'a pas d'API publique : on lit une API tierce
 * non officielle (par défaut fomo-api.com, board « fomo-parity » = chiffres tels que FOMO les affiche),
 * qui relie chaque trader à ses adresses Solana. Sans clé : top 10.
 */
import { PublicKey } from '@solana/web3.js';
import type { Settings } from './env.js';

export interface Leader {
  handle: string; displayName: string | null; avatarUrl: string | null; rank: number;
  pnlUsd: number | null; wallets: string[]; window: string; source: string; syncedAt: string | null;
}

const isSolanaAddress = (a: unknown): a is string => {
  if (typeof a !== 'string' || a.length < 32 || a.length > 44) return false;
  try { return new PublicKey(a).toBase58() === a; } catch { return false; }
};

export async function fetchLeaderboard(s: Settings): Promise<Leader[]> {
  const url = new URL(s.leaderboardUrl);
  url.searchParams.set('window', s.leaderboardWindow);
  url.searchParams.set('limit', String(s.fomoApiKey ? 50 : 10));
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (s.fomoApiKey) headers.Authorization = `Bearer ${s.fomoApiKey}`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`Classement FOMO indisponible (HTTP ${r.status})`);
  const body = (await r.json()) as Record<string, any>;
  const rows: any[] = Array.isArray(body.data) ? body.data : Array.isArray(body.traders) ? body.traders : [];
  if (!rows.length) throw new Error('Classement FOMO vide');

  const leaders: Leader[] = [];
  for (const row of rows) {
    const raw = row.wallets;
    const list: string[] = Array.isArray(raw)
      ? raw.filter((w: any) => w?.chain === 'solana').map((w: any) => w.address)
      : raw && typeof raw === 'object' ? [raw.solana] : [row.solana ?? row.address];
    const wallets = [...new Set(list.filter(isSolanaAddress))];
    if (!wallets.length) continue;
    leaders.push({
      handle: String(row.handle ?? row.traderId ?? wallets[0]), displayName: row.displayName ?? null,
      avatarUrl: row.avatarUrl ?? null, rank: Number(row.rank),
      pnlUsd: typeof row.pnlUsd === 'number' ? row.pnlUsd : null, wallets,
      window: String(body.window ?? s.leaderboardWindow), source: String(row.source ?? body.source ?? 'unknown'),
      syncedAt: body.syncedAt ?? null,
    });
  }
  if (!leaders.length) throw new Error('Aucun trader du classement n’a d’adresse Solana connue');
  return s.mode === 'TOP1' ? leaders.slice(0, 1) : leaders.slice(0, s.basketSize);
}
