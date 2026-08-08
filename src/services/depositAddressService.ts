import { createHash } from "node:crypto";
import { logger } from "../lib/logger.js";

/**
 * Deposit Address Service
 *
 * v2 Architecture: Deposits go to USER WALLETS, not deal-specific addresses.
 * Each user+network gets a deterministic deposit address.
 * The blockchain monitor watches all user deposit addresses.
 *
 * In production, derive from an HD wallet (BIP-44).
 * For MVP, use a static platform address per network.
 */

// Cache of user deposit addresses to avoid recomputation
const addressCache = new Map<string, string>();

/**
 * Get the deposit address for a user on a specific network.
 * In production: derive from HD wallet using userId as index.
 * For MVP: return the static platform address for this network.
 */
export function getUserDepositAddress(userId: string, network: string): string {
  const cacheKey = `${userId}:${network}`;
  const cached = addressCache.get(cacheKey);
  if (cached) return cached;

  // Check for static platform address
  const staticAddr = process.env[`DEPOSIT_ADDRESS_${network}`];
  if (staticAddr) {
    addressCache.set(cacheKey, staticAddr);
    return staticAddr;
  }

  // Fallback: deterministic derivation (not a real blockchain address)
  const hash = createHash("sha256")
    .update(`deposit:${network}:${userId}`)
    .digest("hex");

  const prefix = network === "TRC20" ? "T" : "0x";
  const addr = prefix + hash.slice(0, 34);
  logger.warn(
    { network, userId, address: addr },
    "Using derived address — configure DEPOSIT_ADDRESS_<NETWORK>"
  );

  addressCache.set(cacheKey, addr);
  return addr;
}

/**
 * Get ALL monitored deposit addresses for a network.
 * Returns unique platform addresses (or derived addresses) for all active users.
 */
export async function getMonitoredAddresses(network: string): Promise<string[]> {
  const { prisma } = await import("../lib/db.js");

  // If a static address is configured, just return that
  const staticAddr = process.env[`DEPOSIT_ADDRESS_${network}`];
  if (staticAddr) return [staticAddr];

  // Otherwise, return all active user addresses
  const users = await prisma.user.findMany({
    where: { status: "ACTIVE" },
    select: { id: true },
  });

  const addresses = users.map((u) => getUserDepositAddress(u.id, network));
  return [...new Set(addresses)];
}

/**
 * Map a deposit address back to the userId that owns it.
 */
export function getUserIdForAddress(address: string, network: string): string | null {
  const staticAddr = process.env[`DEPOSIT_ADDRESS_${network}`];
  if (staticAddr && staticAddr.toLowerCase() === address.toLowerCase()) {
    // Static address means we can't determine user from address alone.
    // The blockchain monitor must match by txHash or use a different strategy.
    return null;
  }
  // For derived addresses, we'd need a reverse lookup table.
  // In production with HD wallets, derive the address for each user and compare.
  return null;
}

// Keep old export name for compatibility but make it a passthrough
export const getDepositAddress = getUserDepositAddress;
