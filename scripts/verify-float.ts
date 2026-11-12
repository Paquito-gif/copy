/**
 * Vérification contre mainnet (lecture + simulation uniquement, aucune transaction envoyée) :
 *  1. nos dérivations reproduisent les 23 comptes d'un lancement Float réel ;
 *  2. la config Float est compatible ;
 *  3. un lancement construit par nous passe la simulation du programme Float.
 * Usage : RPC_URL=... npx tsx scripts/verify-float.ts
 */
import { PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, Keypair } from '@solana/web3.js';
import { Rpc, b64 } from '../src/lib/rpc.js';
import { buildLaunchIx, checkFloatConfig, readLaunchState, isQuoteEnabled, isTickerTaken, TOKEN_PROGRAMS } from '../src/float.js';

const conn = new Rpc(process.env.RPC_URL || 'https://solana-rpc.publicnode.com');
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');

// 1) Lancement réel observé : tx 5qDZVM61…, ticker ALOOOOONG
const expected = `cashzqrxZ2JSwSNFAGtXrYEaLW8DGdWscchn6xYgwUY AgaKFP4SfEeeM4r4GcSWBwpEAbfHh7wLkJGHqpWrLBQV 2LMWFmbGBfw78ZEas2NFmAYfo4bhyBqYboYh9nk3mDFQ B9hvvyGzC2ohdg4PpEU18dPRJaRdxotEVAVJYFQRjmUv So11111111111111111111111111111111111111112 5TfiYQ66aPTLzZ1LweEnx8sDpyKgpxoeRrvVypDfUNAB 87sBctbiuq6B2FTCQzREiqwuUcfHbKWC3UnqqpenbGd8 8V4Ubran2rdGjaeCs3Y6iZdPbxC8kAAbscRKCc4uTZtU DD25Ez4z1KDrMCs5D5aLz2ypdaoj3rJ7GidT3k3bCU9T 6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX 2TDPJJPV6nvTEqXABxrqno6Uzpipxxvh1zjLN3SMYn69 WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh 7y2ZA7e2H7TSumwNT7WEqz3mZsyXH5rcJ7HZF9g4A2E8 7R1ydTcEexVH1ZnXtc4yore92c5yJ2c6t8rQ9YEf7Pyn 3j6Egqcmq1ruZzM9dgF4F1By84K2iiQ59312oKd84c41 AXFF9ErDdvQmwGAEmaxLXne7omgz9eNm9uoRvJ7N6GCp 2DPAtwB8L12vrMRExbLuyGnC7n2J5LNoZQSejeQGpwkr LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s 11111111111111111111111111111111 SysvarRent111111111111111111111111111111111`.split(' ');
const nonce = Buffer.from('da2a75f5c878293d', 'hex').readBigUInt64LE();
const { ix } = buildLaunchIx({
  creator: new PublicKey(expected[0]), feeReceiver: new PublicKey('8HPWgu5Nm8SrieLNrPviBsYxYuKc31s6pYVR8hTmQ4dT'),
  name: 'ALOOOOONG', ticker: 'ALOOOOONG', uri: 'https://gateway.pinata.cloud/ipfs/bafkreigwbjubswge3rv5mbhmm6xy7b4yylhuzxa7qp3ami7giii7mluxku',
  quoteMint: WSOL, quoteTokenProgram: TOKEN_PROGRAMS.TOKEN, tier: 0, nonce,
});
const got = ix.keys.map((k) => k.pubkey.toBase58());
const diff = got.map((k, i) => (k === expected[i] ? null : `#${i} ${k} ≠ ${expected[i]}`)).filter(Boolean);
console.log(diff.length ? `❌ dérivations: ${diff.join(', ')}` : '✅ 23/23 comptes identiques au lancement réel');
console.log(ix.data.length === 180 ? '✅ données : 180 octets, comme on-chain' : `❌ données : ${ix.data.length} octets (attendu 180)`);

// 2) Config
const cfg = await checkFloatConfig(conn);
console.log('✅ config Float OK, split', cfg.split);

// 3) LaunchState lisible
const st = await readLaunchState(conn, new PublicKey('87sBctbiuq6B2FTCQzREiqwuUcfHbKWC3UnqqpenbGd8'));
console.log(st?.feeReceiver === '8HPWgu5Nm8SrieLNrPviBsYxYuKc31s6pYVR8hTmQ4dT' ? '✅ LaunchState décodé (feeReceiver ≠ créateur)' : '❌ LaunchState', st?.feeReceiver);

// 4) Simulation d'un NOUVEAU lancement avec un fee_receiver à nous
console.log('wSOL activé :', await isQuoteEnabled(conn, WSOL));
const creator = new PublicKey(expected[0]); // wallet existant avec du SOL, pour la simulation uniquement
const feeReceiver = Keypair.generate().publicKey;
const ticker = 'T' + Math.random().toString(36).slice(2, 9).toUpperCase();
console.log('ticker libre :', !(await isTickerTaken(conn, ticker)), ticker);
const sim = buildLaunchIx({
  creator, feeReceiver, name: 'Sim Test', ticker, uri: 'https://example.com/m/test.json',
  quoteMint: WSOL, quoteTokenProgram: TOKEN_PROGRAMS.TOKEN, tier: 0, nonce: BigInt(Date.now()),
});
const { blockhash } = await conn.getLatestBlockhash();
const msg = new TransactionMessage({
  payerKey: creator, recentBlockhash: blockhash,
  instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), sim.ix],
}).compileToV0Message();
const res = await conn.simulate(b64(new VersionedTransaction(msg).serialize()), { replaceRecentBlockhash: true });
const logs = res.logs ?? [];
console.log(res.err ? `❌ simulation: ${JSON.stringify(res.err)}` : `✅ simulation OK (${res.unitsConsumed} CU), mint ${sim.mint.toBase58()}`);
console.log(logs.filter((l) => /Instruction:|Error|failed|success/i.test(l)).slice(0, 15).join('\n'));
