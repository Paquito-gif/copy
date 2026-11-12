/**
 * Client JSON-RPC Solana minimal, basé sur fetch (compatible Cloudflare Workers).
 * On n'utilise pas `Connection` de @solana/web3.js : elle tire WebSocket et Node.
 */
export interface AccountInfo { owner: string; lamports: number; data: Uint8Array }

export class Rpc {
  private urls: string[];
  private i = 0;
  /** `url` peut lister plusieurs RPC séparés par des virgules : on passe au suivant en cas de refus (429, 5xx). */
  constructor(url: string) {
    this.urls = url.split(',').map((u) => u.trim()).filter(Boolean);
    if (!this.urls.length) throw new Error('RPC_URL manquant');
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    let lastErr: unknown;
    const tries = Math.max(3, this.urls.length * 2);
    for (let attempt = 0; attempt < tries; attempt++) {
      const url = this.urls[(this.i + attempt) % this.urls.length];
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        if (r.status === 429 || r.status >= 500) throw new Error(`RPC ${method} HTTP ${r.status}`);
        const j = (await r.json()) as { result?: T; error?: { message: string } };
        if (j.error) throw new Error(`RPC ${method}: ${j.error.message}`);
        this.i = (this.i + attempt) % this.urls.length; // on garde le RPC qui a répondu
        return j.result as T;
      } catch (e) {
        lastErr = e;
        if (!/HTTP (429|403|5\d\d)|fetch|JSON|blocked|rate/i.test(String(e))) break;
        await new Promise((res) => setTimeout(res, 250 * 2 ** Math.min(attempt, 3)));
      }
    }
    throw lastErr;
  }

  private static decode(v: { owner: string; lamports: number; data: [string, string] } | null): AccountInfo | null {
    if (!v) return null;
    return { owner: v.owner, lamports: v.lamports, data: Uint8Array.from(atob(v.data[0]), (c) => c.charCodeAt(0)) };
  }

  async getAccountInfo(address: string): Promise<AccountInfo | null> {
    const r = await this.call<{ value: any }>('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
    return Rpc.decode(r.value);
  }

  /** Par paquets de 10 (limite des RPC publics) ; si la lecture groupée est refusée, compte par compte. */
  async getMultipleAccounts(addresses: string[]): Promise<(AccountInfo | null)[]> {
    const out: (AccountInfo | null)[] = [];
    for (let i = 0; i < addresses.length; i += 10) {
      const chunk = addresses.slice(i, i + 10);
      try {
        const r = await this.call<{ value: any[] }>('getMultipleAccounts', [chunk, { encoding: 'base64', commitment: 'confirmed' }]);
        out.push(...r.value.map(Rpc.decode));
      } catch {
        for (const a of chunk) out.push(await this.getAccountInfo(a));
      }
    }
    return out;
  }

  async getParsedAccount(address: string): Promise<any | null> {
    const r = await this.call<{ value: any }>('getAccountInfo', [address, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    return r.value;
  }

  async getBalance(address: string): Promise<number> {
    return (await this.call<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }])).value;
  }

  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    return (await this.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
  }

  async simulate(txBase64: string, opts: { accounts?: string[]; replaceRecentBlockhash?: boolean } = {}) {
    const cfg: Record<string, unknown> = { encoding: 'base64', sigVerify: false, commitment: 'confirmed' };
    if (opts.replaceRecentBlockhash) cfg.replaceRecentBlockhash = true;
    if (opts.accounts) cfg.accounts = { encoding: 'base64', addresses: opts.accounts };
    const r = await this.call<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number; accounts?: ({ lamports: number } | null)[] } }>(
      'simulateTransaction', [txBase64, cfg]);
    return r.value;
  }

  async send(txBase64: string): Promise<string> {
    return this.call<string>('sendTransaction', [txBase64, { encoding: 'base64', skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed' }]);
  }

  /** Attend la confirmation (au plus ~45 s, adapté à la durée d'une requête Worker). */
  async confirm(signature: string, timeoutMs = 45_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const r = await this.call<{ value: ({ err: unknown; confirmationStatus: string } | null)[] }>('getSignatureStatuses', [[signature]]);
      const s = r.value[0];
      if (s?.err) throw new Error(`Transaction échouée ${signature}: ${JSON.stringify(s.err)}`);
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return;
      await new Promise((res) => setTimeout(res, 1500));
    }
    throw new Error(`Transaction non confirmée à temps : ${signature}`);
  }

  async getSlot(): Promise<number> {
    return this.call<number>('getSlot', [{ commitment: 'confirmed' }]);
  }

  async getSignatures(address: string, opts: { limit?: number; until?: string } = {}) {
    return this.call<{ signature: string; slot: number; err: unknown; blockTime: number | null }[]>(
      'getSignaturesForAddress', [address, { limit: opts.limit ?? 20, until: opts.until, commitment: 'confirmed' }]);
  }

  async getParsedTransaction(signature: string): Promise<any | null> {
    return this.call<any>('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
  }

  /** Solde brut d'un mint pour un owner, toutes token accounts confondues (Token et Token-2022). */
  async tokenBalanceRaw(owner: string, mint: string): Promise<bigint> {
    const r = await this.call<{ value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] }>(
      'getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    return r.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  }

  /** Infos d'un mint : programme, décimales, autorités. */
  async mintInfo(mint: string): Promise<{ program: string; decimals: number; mintAuthority: string | null; freezeAuthority: string | null }> {
    const acc = await this.getParsedAccount(mint);
    if (!acc) throw new Error(`Mint introuvable : ${mint}`);
    const info = acc.data?.parsed?.info;
    if (!info) throw new Error(`Mint illisible : ${mint}`);
    return { program: acc.owner, decimals: info.decimals, mintAuthority: info.mintAuthority ?? null, freezeAuthority: info.freezeAuthority ?? null };
  }
}

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const b64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
