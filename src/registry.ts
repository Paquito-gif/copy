/** Registre des coins lancés via le launchpad (partagé entre le site et le moteur). */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './engine/config.js';

export interface Coin {
  mint: string;
  name: string;
  ticker: string;
  image: string;
  description: string;
  quoteMint: string;
  quoteSymbol: string;
  tier: number;
  creator: string;
  signature: string;
  launchedAt: number;
}

fs.mkdirSync(config.dataDir, { recursive: true });
const file = path.join(config.dataDir, 'coins.json');

export function listCoins(): Coin[] {
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Coin[]) : [];
}

export function addCoin(c: Coin) {
  const coins = listCoins();
  if (coins.some((x) => x.mint === c.mint)) return;
  coins.unshift(c);
  fs.writeFileSync(file, JSON.stringify(coins, null, 2));
}
