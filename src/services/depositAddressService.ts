import { createHash } from "node:crypto";
import { HDNodeWallet } from "ethers";
import { prisma } from "../lib/db.js";
import { logger } from "../lib/logger.js";

/**
 * Deposit Address Service
 *
 * Per-user deposit addresses derived deterministically from a server-side
 * BIP-44 HD wallet seed (DEPOSIT_HD_MNEMONIC):
 *
 *   address_index = sha256("deposit-index:" + userId) % 2^31
 *   BEP20/ERC20  : m/44'/60'/0'/0/{address_index}   (EVM coin type)
 *   TRC20        : m/44'/195'/0'/0/{address_index}  (TRON coin type)
 *
 * The derived address is persisted in `deposit_addresses` mapped to
 * (userId, network, asset) so that:
 *   - the SAME address is reused for a user/network on every deposit screen
 *     view (never a new address per request), and
 *   - the blockchain monitor can attribute a deposit by
 *     (network, asset, destination address) -> userId.
 *
 * SECURITY:
 *   - The mnemonic is read from the environment on every call and is never
 *     logged, stored in the database, or exposed to Telegram users.
 *   - If DEPOSIT_HD_MNEMONIC is missing or invalid, address generation
 *     returns null — callers must show "Deposits temporarily unavailable"
 *     and MUST NOT fabricate an address.
 *   - The mnemonic is used ONLY for deposit-address derivation. It is never
 *     used as a withdrawal signing key.
 */

const MNEMONIC_ENV = "DEPOSIT_HD_MNEMONIC";

// BIP-44 coin types per network.
const COIN_TYPES: Record<string, number> = {
  TRC20: 195, // TRON
  BEP20: 60,  // EVM (BSC)
  ERC20: 60,  // EVM (Ethereum)
};

// ─── Mnemonic access (never logged) ─────────────────────────────────────

function getMnemonic(): string {
  return process.env[MNEMONIC_ENV] ?? "";
}

/**
 * Deterministic, stable address index for a user. Same user => same index
 * across restarts, so addresses never change for a user.
 */
export function userAddressIndex(userId: string): number {
  const hash = createHash("sha256").update(`deposit-index:${userId}`).digest("hex");
  // BIP-44 address indexes must be < 2^31.
  return parseInt(hash.slice(0, 8), 16) % 0x7fffffff;
}

function derivationPath(network: string, index: number): string {
  const coinType = COIN_TYPES[network] ?? 60;
  return `m/44'/${coinType}'/0'/0/${index}`;
}

// ─── TRON base58 / address conversion ───────────────────────────────────

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  for (const b of bytes) {
    if (b === 0) zeros++;
    else break;
  }

  let digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = "";
  for (let i = 0; i < zeros; i++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]];
  return out;
}

function base58Decode(value: string): Uint8Array | null {
  const bytes: number[] = [];
  for (const ch of value) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    let carry = idx;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const leadingOnes = value.match(/^1*/)?.[0].length ?? 0;
  const result = new Array<number>(leadingOnes).fill(0).concat(bytes.reverse());
  return Uint8Array.from(result);
}

function sha256d(data: Buffer): Buffer {
  return createHash("sha256").update(createHash("sha256").update(data).digest()).digest();
}

/**
 * Convert an EVM hex address (0x…) to a TRON base58 address:
 *   0x41 + last-20-bytes + 4-byte double-SHA256 checksum, base58 encoded.
 */
function ethAddressToTron(ethAddress: string): string {
  const hex = ethAddress.replace(/^0x/i, "").toLowerCase();
  const payload = Buffer.from(`41${hex}`, "hex"); // 21 bytes
  const checksum = sha256d(payload).subarray(0, 4);
  return base58Encode(Buffer.concat([payload, checksum]));
}

/**
 * Validate a TRON address offline: base58, 34 chars, 0x41 prefix and a valid
 * double-SHA256 checksum.
 */
function isValidTronAddress(address: string): boolean {
  if (typeof address !== "string" || address.length !== 34 || !address.startsWith("T")) {
    return false;
  }
  const decoded = base58Decode(address);
  if (!decoded || decoded.length !== 25) return false;
  if (decoded[0] !== 0x41) return false;
  const payload = Buffer.from(decoded.subarray(0, 21));
  const checksum = Buffer.from(decoded.subarray(21));
  return sha256d(payload).subarray(0, 4).equals(checksum);
}

// ─── Derivation + validation ────────────────────────────────────────────

export function isValidDepositAddress(network: string, address: string): boolean {
  const n = network.toUpperCase();
  if (n === "TRC20") return isValidTronAddress(address);
  if (n === "BEP20" || n === "ERC20") return /^0x[a-fA-F0-9]{40}$/.test(address);
  return false;
}

/**
 * Derive the network-specific deposit address for a user, or null if the
 * mnemonic is missing/invalid or the network is unsupported. NEVER fabricates
 * an address.
 */
export function deriveDepositAddress(network: string, userId: string): string | null {
  const n = network.toUpperCase();
  if (!COIN_TYPES[n]) {
    logger.warn({ network: n }, "Unsupported deposit network");
    return null;
  }

  const mnemonic = getMnemonic();
  if (!mnemonic) {
    logger.warn("DEPOSIT_HD_MNEMONIC is not set — deposit addresses unavailable");
    return null;
  }

  let ethAddress: string;
  try {
    const index = userAddressIndex(userId);
    const wallet = HDNodeWallet.fromPhrase(mnemonic, undefined, derivationPath(n, index));
    ethAddress = wallet.address;
  } catch (e) {
    logger.error({ err: e }, "DEPOSIT_HD_MNEMONIC is invalid — deposit addresses unavailable");
    return null;
  }

  const address = n === "TRC20" ? ethAddressToTron(ethAddress) : ethAddress.toLowerCase();
  if (!isValidDepositAddress(n, address)) {
    logger.error({ network: n }, "Derived deposit address failed network validation");
    return null;
  }
  return address;
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Get (and persist) the deposit address for a user/network/asset.
 * Returns null when the mnemonic is missing/invalid — never a fake address.
 * The same address is reused for the user/network on subsequent calls.
 */
export async function getUserDepositAddress(
  userId: string,
  network: string,
  asset = "USDT"
): Promise<string | null> {
  const n = network.toUpperCase();

  // 1. Reuse an existing mapping if present.
  const existing = await prisma.depositAddress.findFirst({
    where: { userId, network: n, asset },
  });
  if (existing) return existing.address;

  // 2. Derive (returns null when mnemonic is missing/invalid).
  const address = deriveDepositAddress(n, userId);
  if (!address) return null;

  // 3. Persist the mapping (idempotent; unique on network+asset+address).
  try {
    const row = await prisma.depositAddress.upsert({
      where: { deposit_address_unique: { network: n, asset, address } },
      create: { userId, network: n, asset, address },
      update: {},
    });
    // A single address must never be shared between two users.
    if (row.userId !== userId) {
      logger.error(
        { network: n, asset },
        "Derived deposit address already belongs to another user — refusing to reuse it"
      );
      return null;
    }
    return row.address;
  } catch (e) {
    logger.error({ userId, network: n, err: e }, "Failed to persist deposit address");
    return null;
  }
}

/**
 * All deposit addresses the blockchain monitor should watch for a network.
 */
export async function getMonitoredAddresses(network: string, asset = "USDT"): Promise<string[]> {
  const rows = await prisma.depositAddress.findMany({
    where: { network: network.toUpperCase(), asset },
    select: { address: true },
  });
  return [...new Set(rows.map((r) => r.address))];
}

/**
 * Map a deposit address back to the owning userId.
 * This is the (network, asset, destination address) -> user attribution used
 * by the blockchain monitor.
 */
export async function getUserIdForAddress(
  address: string,
  network: string,
  asset = "USDT"
): Promise<string | null> {
  const n = network.toUpperCase();
  // EVM addresses are stored lowercase; compare case-insensitively.
  const normalized = n === "TRC20" ? address : String(address).toLowerCase();
  const row = await prisma.depositAddress.findFirst({
    where: { network: n, asset, address: normalized },
    select: { userId: true },
  });
  return row?.userId ?? null;
}

/** True when a valid deposit mnemonic is configured. */
export function isDepositConfigured(): boolean {
  const mnemonic = getMnemonic();
  if (!mnemonic) return false;
  try {
    HDNodeWallet.fromPhrase(mnemonic);
    return true;
  } catch {
    return false;
  }
}

// Keep old export name for compatibility (now async, DB-backed).
export const getDepositAddress = getUserDepositAddress;
