import { Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { config } from './config.js';

export const connection = new Connection(config.rpcUrl, { commitment: 'confirmed', wsEndpoint: config.wsUrl });

function loadKeypair(secret: string): Keypair {
  const s = secret.trim();
  if (s.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s)));
  return Keypair.fromSecretKey(bs58.decode(s));
}

/** Le wallet bot n'est chargé que par le moteur (jamais par le serveur web). */
let _bot: Keypair | null = null;
export function bot(): Keypair {
  if (!_bot) {
    if (!config.botSecret) throw new Error('BOT_PRIVATE_KEY manquante (nécessaire pour le moteur)');
    _bot = loadKeypair(config.botSecret);
    if (_bot.publicKey.toBase58() !== config.feeReceiver) {
      throw new Error('BOT_PRIVATE_KEY ne correspond pas à FEE_RECEIVER');
    }
  }
  return _bot;
}

export const feeReceiver = new PublicKey(config.feeReceiver);

export const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

export async function solBalance(owner: PublicKey): Promise<number> {
  return (await connection.getBalance(owner)) / LAMPORTS_PER_SOL;
}

export async function mintProgram(mint: PublicKey): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint introuvable : ${mint.toBase58()}`);
  return info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

export async function mintInfo(mint: PublicKey) {
  const program = await mintProgram(mint);
  return { program, ...(await getMint(connection, mint, 'confirmed', program)) };
}

export async function tokenBalanceRaw(owner: PublicKey, mint: PublicKey): Promise<bigint> {
  const res = await connection.getParsedTokenAccountsByOwner(owner, { mint });
  return res.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount as string), 0n);
}

export async function sendVersioned(tx: VersionedTransaction, signer: Keypair): Promise<string> {
  tx.sign([signer]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const bh = await connection.getLatestBlockhash();
  const res = await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
  if (res.value.err) throw new Error(`Tx échouée ${sig}: ${JSON.stringify(res.value.err)}`);
  return sig;
}
