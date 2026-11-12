import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });

export interface Position {
  mint: string; trader: string; amountRaw: string; costSol: number; openedAt: number;
}

export interface Event {
  t: number;
  kind: 'convert' | 'buy' | 'sell' | 'buyback' | 'burn' | 'pause';
  detail: Record<string, unknown>;
}

export interface CoinStats {
  /** Valeur cumulée (en SOL) de la part créateur générée par ce coin. */
  feesSol: number;
  /** SOL déjà dépensé en buyback pour ce coin. */
  buybackSol: number;
  burnedRaw: string;
  /** Dernière part créateur lue on-chain (unités brutes du quote), pour calculer les nouveaux fees. */
  lastDevShareRaw: string;
}

export interface EngineState {
  positions: Record<string, Position>;
  realizedPnlSol: number;
  buybackBucketSol: number;
  totalFeesSol: number;
  coins: Record<string, CoinStats>;
  dayStart: number; dayStartCapitalSol: number; dayRealizedSol: number;
  paused: boolean;
  events: Event[];
}

const file = path.join(config.dataDir, 'engine.json');
const empty = (): EngineState => ({
  positions: {}, realizedPnlSol: 0, buybackBucketSol: 0, totalFeesSol: 0, coins: {},
  dayStart: 0, dayStartCapitalSol: 0, dayRealizedSol: 0, paused: false, events: [],
});

export const state: EngineState = fs.existsSync(file) ? { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) } : empty();

export function readEngineState(): EngineState {
  return fs.existsSync(file) ? { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) } : empty();
}

export function save() {
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

export function record(kind: Event['kind'], detail: Record<string, unknown>) {
  state.events.push({ t: Date.now(), kind, detail });
  if (state.events.length > 5000) state.events.splice(0, state.events.length - 5000);
  save();
}

export function coinStats(mint: string): CoinStats {
  return (state.coins[mint] ??= { feesSol: 0, buybackSol: 0, burnedRaw: '0', lastDevShareRaw: '0' });
}
