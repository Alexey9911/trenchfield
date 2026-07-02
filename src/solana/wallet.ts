// Injected-wallet integration (Phantom / Solflare / Backpack), SOLBALL-style:
// connect → nonce → signMessage auth → stake via SystemProgram transfer.
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import bs58 from 'bs58';

interface InjectedProvider {
  publicKey?: { toBase58(): string } | null;
  isConnected?: boolean;
  connect(): Promise<{ publicKey: { toBase58(): string } }>;
  disconnect?(): Promise<void>;
  signMessage(msg: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array } | Uint8Array>;
  signAndSendTransaction?(tx: Transaction): Promise<{ signature: string }>;
  signTransaction?(tx: Transaction): Promise<Transaction>;
}

export interface WalletInfo {
  id: string;
  label: string;
  provider: InjectedProvider;
}

declare global {
  interface Window {
    phantom?: { solana?: InjectedProvider };
    solana?: InjectedProvider & { isPhantom?: boolean };
    solflare?: InjectedProvider;
    backpack?: InjectedProvider;
  }
}

const RPC_URL =
  (import.meta.env.VITE_SOLANA_RPC as string | undefined) ?? 'https://api.devnet.solana.com';

export function detectWallets(): WalletInfo[] {
  const found: WalletInfo[] = [];
  const phantom = window.phantom?.solana ?? (window.solana?.isPhantom ? window.solana : undefined);
  if (phantom) found.push({ id: 'phantom', label: 'Phantom', provider: phantom });
  if (window.solflare) found.push({ id: 'solflare', label: 'Solflare', provider: window.solflare });
  if (window.backpack) found.push({ id: 'backpack', label: 'Backpack', provider: window.backpack });
  return found;
}

export async function connectWallet(w: WalletInfo): Promise<string> {
  const res = await w.provider.connect();
  return res.publicKey.toBase58();
}

export async function signAuthMessage(w: WalletInfo, message: string): Promise<string> {
  const bytes = new TextEncoder().encode(message);
  const sig = await w.provider.signMessage(bytes, 'utf8');
  const raw = sig instanceof Uint8Array ? sig : sig.signature;
  return bs58.encode(raw);
}

/** Transfer `amountSol` to the escrow. Returns the tx signature. */
export async function payStake(w: WalletInfo, escrow: string, amountSol: number): Promise<string> {
  const from = new PublicKey(w.provider.publicKey!.toBase58());
  const connection = new Connection(RPC_URL, 'confirmed');
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from,
      toPubkey: new PublicKey(escrow),
      lamports: Math.round(amountSol * LAMPORTS_PER_SOL),
    }),
  );
  tx.feePayer = from;
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;

  if (w.provider.signAndSendTransaction) {
    const { signature } = await w.provider.signAndSendTransaction(tx);
    return signature;
  }
  if (w.provider.signTransaction) {
    const signed = await w.provider.signTransaction(tx);
    return connection.sendRawTransaction(signed.serialize());
  }
  throw new Error('wallet cannot sign transactions');
}

export async function walletBalance(pubkey: string): Promise<number> {
  try {
    const connection = new Connection(RPC_URL, 'confirmed');
    const lamports = await connection.getBalance(new PublicKey(pubkey));
    return lamports / LAMPORTS_PER_SOL;
  } catch {
    return 0;
  }
}
