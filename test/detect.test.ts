import assert from 'node:assert';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
process.env.RPC_URL = 'http://127.0.0.1:8899';
const botKp = Keypair.generate();
process.env.BOT_PRIVATE_KEY = bs58.encode(botKp.secretKey);
process.env.FEE_RECEIVER = botKp.publicKey.toBase58();
const trader = Keypair.generate().publicKey;
process.env.TRADERS = trader.toBase58();
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-test-'));
const { detectSwap } = await import('../src/engine/copytrader.js');
const { addCoin } = await import('../src/registry.js');
const OWN = Keypair.generate().publicKey.toBase58();
addCoin({ mint: OWN, name: 'x', ticker: 'X', image: '', description: '', quoteMint: '', quoteSymbol: '', tier: 0, creator: '', signature: '', launchedAt: 0 });
const MEME = Keypair.generate().publicKey.toBase58();
const tb = (mint: string, amt: number) => ({ accountIndex: 1, mint, owner: trader.toBase58(), uiTokenAmount: { uiAmount: amt, amount: '0', decimals: 6, uiAmountString: '' } });
const mk = (preSol: number, postSol: number, pre: any[], post: any[], err: any = null) => ({
  transaction: { message: { accountKeys: [{ pubkey: trader }] } },
  meta: { err, preBalances: [preSol * 1e9], postBalances: [postSol * 1e9], preTokenBalances: pre, postTokenBalances: post },
}) as any;
const t = trader.toBase58();
assert.deepEqual(detectSwap(mk(10, 9, [], [tb(MEME, 1000)]), t)?.side, 'buy');
const sell = detectSwap(mk(9, 9.6, [tb(MEME, 1000)], [tb(MEME, 250)]), t);
assert.equal(sell?.side, 'sell'); assert.equal(sell?.soldFraction, 0.75);
// achat payé en WSOL
assert.equal(detectSwap(mk(10, 10, [tb('So11111111111111111111111111111111111111112', 5)], [tb('So11111111111111111111111111111111111111112', 4), tb(MEME, 50)]), t)?.side, 'buy');
assert.equal(detectSwap(mk(10, 9, [], [tb(MEME, 1000)], { x: 1 }), t), null); // tx échouée
assert.equal(detectSwap(mk(10, 9.99, [], []), t), null); // simple transfert
assert.equal(detectSwap(mk(10, 9, [], [tb(OWN, 1)]), t), null); // coins du launchpad ignorés
console.log('detectSwap: 6/6 OK');
process.exit(0);
