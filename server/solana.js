// Solana escrow: house wallet custody of stakes, on-chain deposit verification,
// payouts. Mirrors the battle-tested SOLBALL flow (ledger before pay, sig replay
// protection, RPC rotation with retries).
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import bs58 from 'bs58';

const CLUSTER = process.env.SOLANA_CLUSTER || 'devnet';

function buildRpcUrls() {
  const urls = [];
  if (process.env.SOLANA_RPC) urls.push(...process.env.SOLANA_RPC.split(',').map((s) => s.trim()));
  const heliusKeys = (process.env.HELIUS_API_KEYS || process.env.HELIUS_API_KEY || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const k of heliusKeys) {
    urls.push(
      CLUSTER === 'mainnet-beta'
        ? `https://mainnet.helius-rpc.com/?api-key=${k}`
        : `https://devnet.helius-rpc.com/?api-key=${k}`,
    );
  }
  urls.push(
    CLUSTER === 'mainnet-beta'
      ? 'https://api.mainnet-beta.solana.com'
      : 'https://api.devnet.solana.com',
  );
  return [...new Set(urls)];
}

const RPC_URLS = buildRpcUrls();
let rpcIndex = 0;

function nextConnection() {
  const url = RPC_URLS[rpcIndex % RPC_URLS.length];
  rpcIndex += 1;
  return new Connection(url, 'confirmed');
}

async function rpcTry(fn, attempts = RPC_URLS.length) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(nextConnection());
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// --- house wallet ---
let houseKeypair = null;
try {
  const secret = (process.env.HOUSE_WALLET_SECRET || '').trim();
  if (secret) {
    houseKeypair = secret.startsWith('[')
      ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)))
      : Keypair.fromSecretKey(bs58.decode(secret));
    console.log(`[solana] escrow wallet: ${houseKeypair.publicKey.toBase58()} (${CLUSTER})`);
  } else {
    console.log('[solana] HOUSE_WALLET_SECRET not set — wagers disabled');
  }
} catch (err) {
  console.error('[solana] bad HOUSE_WALLET_SECRET:', err.message);
}

export const wagersEnabled = Boolean(houseKeypair);
export const escrowAddress = houseKeypair ? houseKeypair.publicKey.toBase58() : null;
export const cluster = CLUSTER;

/**
 * Verify on-chain that `sig` is a SystemProgram transfer of >= amountSol
 * from `wallet` to the escrow. Retries to tolerate RPC propagation lag.
 * @returns verified lamports (0 when invalid)
 */
export async function verifyDeposit(sig, wallet, amountSol) {
  if (!houseKeypair) return 0;
  const wantLamports = Math.round(amountSol * LAMPORTS_PER_SOL);
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const tx = await rpcTry((c) =>
        c.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }),
      );
      if (tx && !tx.meta?.err) {
        const instructions = tx.transaction.message.instructions ?? [];
        for (const ix of instructions) {
          const p = ix.parsed;
          if (
            ix.program === 'system' &&
            p?.type === 'transfer' &&
            p.info?.destination === houseKeypair.publicKey.toBase58() &&
            p.info?.source === wallet &&
            Number(p.info?.lamports) >= wantLamports
          ) {
            return Number(p.info.lamports);
          }
        }
        return 0; // confirmed but not a matching transfer
      }
    } catch {
      /* rotate + retry */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return 0;
}

/**
 * Pay `amountSol` from the escrow to `wallet`.
 * @returns tx signature or null on failure
 */
export async function payout(wallet, amountSol) {
  if (!houseKeypair || amountSol <= 0) return null;
  try {
    const to = new PublicKey(wallet);
    const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
    return await rpcTry(async (c) => {
      const tx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: houseKeypair.publicKey, toPubkey: to, lamports }),
      );
      const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = houseKeypair.publicKey;
      tx.sign(houseKeypair);
      const sig = await c.sendRawTransaction(tx.serialize());
      await c.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
      return sig;
    }, 3);
  } catch (err) {
    console.error(`[solana] payout to ${wallet} failed:`, err.message);
    return null;
  }
}

export async function escrowBalance() {
  if (!houseKeypair) return 0;
  try {
    const lamports = await rpcTry((c) => c.getBalance(houseKeypair.publicKey));
    return lamports / LAMPORTS_PER_SOL;
  } catch {
    return 0;
  }
}
