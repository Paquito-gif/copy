/**
 * Classement FOMO → wallet(s) à copier.
 *
 * fomo.family n'a pas d'API publique. On lit le classement via une API tierce non officielle
 * (par défaut fomo-api.com, board « fomo-parity » = les chiffres tels que FOMO les affiche),
 * qui relie chaque trader à ses adresses Solana. Sans clé : top 10 ; avec FOMO_API_KEY : plus.
 *
 * Le n°1 retenu est le premier trader du classement qui a au moins une adresse Solana connue.
 * Le résultat est enregistré dans data/leader.json, lu par le moteur et par le site.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { config } from './config.js';
import { log } from './solana.js';

export interface Leader {
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  rank: number;
  pnlUsd: number | null;
  wallets: string[];        // adresses Solana du trader (il peut en avoir plusieurs)
  window: string;           // 24h, 7d ou 30d
  source: string;           // « fomo » = chiffres de FOMO ; « computed » = recalculés par l'API
  syncedAt: string | null;  // fraîcheur du classement côté API
}

export interface LeaderState {
  current: Leader[];        // TOP1 : 1 trader ; BASKET : les N premiers
  checkedAt: number;
  changedAt: number;
  history: { at: number; handles: string[] }[];
}

const file = () => path.join(config.dataDir, 'leader.json');

export function readLeaderState(): LeaderState | null {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')) as LeaderState; } catch { return null; }
}

function writeLeaderState(s: LeaderState) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(s, null, 2));
}

const isSolanaAddress = (a: unknown): a is string => {
  if (typeof a !== 'string' || a.length < 32 || a.length > 44) return false;
  try { return new PublicKey(a).toBase58() === a; } catch { return false; }
};

/** Lit le classement et renvoie les traders avec au moins une adresse Solana, dans l'ordre. */
export async function fetchLeaderboard(): Promise<Leader[]> {
  const url = new URL(config.leaderboardUrl);
  url.searchParams.set('window', config.leaderboardWindow);
  url.searchParams.set('limit', String(config.fomoApiKey ? 50 : 10));
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.fomoApiKey) headers.Authorization = `Bearer ${config.fomoApiKey}`;

  const r = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`Classement FOMO indisponible (HTTP ${r.status})`);
  const body = (await r.json()) as Record<string, unknown>;
  const rows = (Array.isArray(body.data) ? body.data : Array.isArray(body.traders) ? body.traders : []) as Record<string, any>[];
  if (!rows.length) throw new Error('Classement FOMO vide');

  const leaders: Leader[] = [];
  for (const row of rows) {
    // formats connus : wallets = [{chain, address}] (fomo-api.com) ou { solana: "…" } (fomoapi.io)
    const raw = row.wallets;
    const list: string[] = Array.isArray(raw)
      ? raw.filter((w: any) => w?.chain === 'solana').map((w: any) => w.address)
      : raw && typeof raw === 'object' ? [raw.solana] : [row.solana ?? row.address];
    const wallets = [...new Set(list.filter(isSolanaAddress))];
    if (!wallets.length) continue; // trader sans adresse Solana connue : on ne peut pas le copier
    leaders.push({
      handle: String(row.handle ?? row.traderId ?? wallets[0]),
      displayName: row.displayName ?? null,
      avatarUrl: row.avatarUrl ?? null,
      rank: Number(row.rank),
      pnlUsd: typeof row.pnlUsd === 'number' ? row.pnlUsd : null,
      wallets,
      window: String(body.window ?? config.leaderboardWindow),
      source: String(row.source ?? body.source ?? 'unknown'),
      syncedAt: (body.syncedAt as string) ?? null,
    });
  }
  if (!leaders.length) throw new Error('Aucun trader du classement n’a d’adresse Solana connue');
  return leaders;
}

/**
 * Scan : lit le classement, garde le n°1 (ou les N premiers en BASKET), enregistre.
 * Renvoie `changed: true` si la sélection a changé depuis le scan précédent.
 */
export async function scanLeader(): Promise<{ state: LeaderState; changed: boolean }> {
  const all = await fetchLeaderboard();
  const picked = config.mode === 'TOP1' ? all.slice(0, 1) : all.slice(0, config.basketSize);
  const prev = readLeaderState();
  const key = (l: Leader[]) => l.map((x) => `${x.handle}:${x.wallets.join(',')}`).join('|');
  const changed = !prev || key(prev.current) !== key(picked);
  const now = Date.now();
  const state: LeaderState = {
    current: picked,
    checkedAt: now,
    changedAt: changed ? now : prev!.changedAt,
    history: changed
      ? [...(prev?.history ?? []), { at: now, handles: picked.map((l) => l.handle) }].slice(-200)
      : prev!.history,
  };
  writeLeaderState(state);
  const top = picked[0];
  log(`${changed ? '🔄 Nouveau' : '✔ Toujours le même'} n°1 FOMO (${top.window}) : ${top.handle} · rang ${top.rank} · ${top.wallets.join(', ')}`
    + (top.rank !== 1 ? ` (le n°1 du classement n'a pas d'adresse Solana connue, on prend le premier copiable)` : ''));
  return { state, changed };
}

/** Wallets à copier : ceux du dernier scan, sinon TRADERS du .env en secours. */
export function leaderWallets(): string[] {
  const s = readLeaderState();
  if (config.traderSource === 'fomo' && s?.current.length) return s.current.flatMap((l) => l.wallets);
  return config.mode === 'TOP1' ? config.traders.slice(0, 1) : config.traders;
}

// Lancement direct : `npm run leader` affiche le n°1 actuel et l'enregistre.
if (process.argv[1]?.endsWith('leaderboard.ts')) {
  scanLeader()
    .then(({ state }) => { console.log(JSON.stringify(state.current, null, 2)); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
