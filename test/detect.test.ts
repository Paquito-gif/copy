import assert from 'node:assert';
import { Keypair } from '@solana/web3.js';
import { detectSwap } from '../src/lib/detect.js';

const trader = Keypair.generate().publicKey.toBase58();
const MEME = Keypair.generate().publicKey.toBase58();
const OWN = Keypair.generate().publicKey.toBase58();
const WSOL = 'So11111111111111111111111111111111111111112';
const tb = (mint: string, amt: number) => ({ accountIndex: 1, mint, owner: trader, uiTokenAmount: { uiAmount: amt, amount: '0', decimals: 6, uiAmountString: '' } });
// format jsonParsed du RPC : accountKeys = [{ pubkey, signer, writable }]
const mk = (preSol: number, postSol: number, pre: any[], post: any[], err: any = null) => ({
  transaction: { message: { accountKeys: [{ pubkey: trader, signer: true, writable: true }] } },
  meta: { err, preBalances: [preSol * 1e9], postBalances: [postSol * 1e9], preTokenBalances: pre, postTokenBalances: post },
});
const own = (m: string) => m === OWN;

assert.equal(detectSwap(mk(10, 9, [], [tb(MEME, 1000)]), trader)?.side, 'buy');
const sell = detectSwap(mk(9, 9.6, [tb(MEME, 1000)], [tb(MEME, 250)]), trader);
assert.equal(sell?.side, 'sell'); assert.equal(sell?.soldFraction, 0.75);
assert.equal(detectSwap(mk(10, 10, [tb(WSOL, 5)], [tb(WSOL, 4), tb(MEME, 50)]), trader)?.side, 'buy'); // payé en WSOL
assert.equal(detectSwap(mk(10, 9, [], [tb(MEME, 1000)], { x: 1 }), trader), null);                  // tx échouée
assert.equal(detectSwap(mk(10, 9.99, [], []), trader), null);                                       // simple transfert
assert.equal(detectSwap(mk(10, 9, [], [tb(OWN, 1)]), trader, own), null);                            // coins du launchpad ignorés
console.log('detectSwap: 6/6 OK');
