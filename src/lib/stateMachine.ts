import { DealStatus } from "@prisma/client";
import type { StateTransition } from "../types/index.js";

// ─── Valid Transitions ─────────────────────────────────────────────────
// Single source of truth. Every deal status change MUST pass canTransition().

const transitions: StateTransition[] = [
  // ── Manual-payment happy path (current model) ──
  { from: "CREATED",            to: "JOINED",            triggeredBy: "SELLER",  condition: "Seller accepts invite (legacy path)" },
  { from: "CREATED",            to: "AWAITING_PAYMENT",  triggeredBy: "ADMIN",   condition: "Escrow admin accepts the deal from the group card" },
  { from: "JOINED",             to: "AWAITING_PAYMENT",  triggeredBy: "SYSTEM",  condition: "Both parties joined — payment instructions shown" },
  { from: "AWAITING_PAYMENT",   to: "PAYMENT_REPORTED",  triggeredBy: "BUYER",   condition: "Buyer reports manual payment (I've Paid)" },
  { from: "AWAITING_PAYMENT",   to: "PAYMENT_REPORTED",  triggeredBy: "SELLER",   condition: "Crypto payer (SELLER) reports manual payment (I've Paid)" },
  { from: "PAYMENT_REPORTED",   to: "AWAITING_PAYMENT",  triggeredBy: "ADMIN",   condition: "Escrower rejects the payment report — buyer may re-report" },
  { from: "PAYMENT_REPORTED",   to: "FUNDED",            triggeredBy: "ADMIN",   condition: "Escrower manually verified payment (ONLY way to FUNDED)" },
  { from: "FUNDED",             to: "DELIVERED",         triggeredBy: "SELLER",  condition: "Seller marks delivered" },
  { from: "FUNDED",             to: "RELEASE_REQUESTED", triggeredBy: "BUYER",   condition: "Buyer requests release (partial or all)" },
  { from: "FUNDED",             to: "RELEASE_REQUESTED", triggeredBy: "SELLER",  condition: "Seller requests release (partial or all)" },
  { from: "DELIVERED",          to: "RELEASE_REQUESTED", triggeredBy: "BUYER",   condition: "Buyer accepts delivery — release requested" },
  { from: "DELIVERED",          to: "RELEASE_REQUESTED", triggeredBy: "SELLER",  condition: "Seller requests release" },
  { from: "RELEASE_REQUESTED",  to: "COMPLETED",         triggeredBy: "ADMIN",   condition: "Escrower manually paid seller — full amount released" },
  { from: "RELEASE_REQUESTED",  to: "DELIVERED",         triggeredBy: "ADMIN",   condition: "Partial manual release — deal continues" },
  { from: "RELEASE_REQUESTED",  to: "FUNDED",            triggeredBy: "ADMIN",   condition: "Partial manual release — deal continues" },

  // ── Manual refund request flow (partial or all) ──
  { from: "FUNDED",             to: "REFUND_REQUESTED",  triggeredBy: "BUYER",   condition: "Buyer requests refund" },
  { from: "FUNDED",             to: "REFUND_REQUESTED",  triggeredBy: "SELLER",  condition: "Seller requests refund" },
  { from: "DELIVERED",          to: "REFUND_REQUESTED",  triggeredBy: "BUYER",   condition: "Buyer requests refund" },
  { from: "DELIVERED",          to: "REFUND_REQUESTED",  triggeredBy: "SELLER",  condition: "Seller requests refund" },
  { from: "REFUND_REQUESTED",   to: "REFUNDED",          triggeredBy: "ADMIN",   condition: "Escrower manually refunded buyer — full amount" },
  { from: "REFUND_REQUESTED",   to: "FUNDED",            triggeredBy: "ADMIN",   condition: "Partial manual refund — deal continues" },
  { from: "REFUND_REQUESTED",   to: "DELIVERED",         triggeredBy: "ADMIN",   condition: "Partial manual refund — deal continues" },

  // ── Dispute path (only after payment is manually verified) ──
  { from: "FUNDED",             to: "DISPUTED",          triggeredBy: "BUYER",   condition: "Buyer opens dispute" },
  { from: "FUNDED",             to: "DISPUTED",          triggeredBy: "SELLER",  condition: "Seller opens dispute" },
  { from: "DELIVERED",          to: "DISPUTED",          triggeredBy: "BUYER",   condition: "Buyer opens dispute" },
  { from: "DELIVERED",          to: "DISPUTED",          triggeredBy: "SELLER",  condition: "Seller opens dispute" },
  { from: "RELEASE_REQUESTED",  to: "DISPUTED",          triggeredBy: "BUYER",   condition: "Buyer opens dispute" },
  { from: "RELEASE_REQUESTED",  to: "DISPUTED",          triggeredBy: "SELLER",  condition: "Seller opens dispute" },
  { from: "REFUND_REQUESTED",   to: "DISPUTED",          triggeredBy: "BUYER",   condition: "Buyer opens dispute" },
  { from: "REFUND_REQUESTED",   to: "DISPUTED",          triggeredBy: "SELLER",  condition: "Seller opens dispute" },

  // ── Admin dispute resolution (manual — escrower pays/refunds outside bot) ──
  { from: "DISPUTED",           to: "UNDER_REVIEW",      triggeredBy: "ADMIN",   condition: "Admin begins review" },
  { from: "UNDER_REVIEW",       to: "RELEASED",          triggeredBy: "ADMIN",   condition: "Manual release to seller (admin confirmed payout)" },
  { from: "UNDER_REVIEW",       to: "REFUNDED",          triggeredBy: "ADMIN",   condition: "Manual refund to buyer (admin confirmed refund)" },
  // RELEASED / REFUNDED are terminal states used for admin dispute resolution.
  // Normal flow goes RELEASE_REQUESTED -> COMPLETED directly.

  // ── Expiration ──
  { from: "CREATED",            to: "EXPIRED",           triggeredBy: "SYSTEM",  condition: "No seller joined" },
  { from: "JOINED",             to: "EXPIRED",           triggeredBy: "SYSTEM",  condition: "No join completion" },
  { from: "AWAITING_PAYMENT",   to: "EXPIRED",           triggeredBy: "SYSTEM",  condition: "Payment not reported before deadline" },

  // ── Cancel path (pre-payment only — bot never touches funds) ──
  { from: "CREATED",            to: "CANCELLED",         triggeredBy: "BUYER",   condition: "Buyer cancels before join" },
  { from: "JOINED",             to: "CANCELLED",         triggeredBy: "BUYER",   condition: "Mutual agreement" },
  { from: "JOINED",             to: "CANCELLED",         triggeredBy: "SELLER",  condition: "Mutual agreement" },
  { from: "AWAITING_PAYMENT",   to: "CANCELLED",         triggeredBy: "BUYER",   condition: "Buyer cancels before reporting payment" },
  { from: "AWAITING_PAYMENT",   to: "CANCELLED",         triggeredBy: "SELLER",  condition: "Seller cancels before payment reported" },
  { from: "PAYMENT_REPORTED",   to: "CANCELLED",         triggeredBy: "BUYER",   condition: "Buyer cancels before verification" },
  // Group cancel by an admin (or the deal creator).
  { from: "CREATED",            to: "CANCELLED",         triggeredBy: "ADMIN",   condition: "Admin cancels from the group card" },
  { from: "JOINED",             to: "CANCELLED",         triggeredBy: "ADMIN",   condition: "Admin cancels from the group card" },
  { from: "AWAITING_PAYMENT",   to: "CANCELLED",         triggeredBy: "ADMIN",   condition: "Admin cancels before payment" },
  { from: "PAYMENT_REPORTED",   to: "CANCELLED",         triggeredBy: "ADMIN",   condition: "Admin cancels before verification" },

  // ── Legacy custodial transitions (kept for historical rows + ledger tests) ──
  { from: "JOINED",            to: "AWAITING_FUNDING",  triggeredBy: "SYSTEM",  condition: "LEGACY: both parties accepted" },
  { from: "AWAITING_FUNDING",  to: "FUNDED",            triggeredBy: "SYSTEM",  condition: "LEGACY: buyer balance locked + buyer fee collected" },
  { from: "FUNDED",            to: "IN_PROGRESS",       triggeredBy: "SYSTEM",  condition: "LEGACY: auto or manual start" },
  { from: "IN_PROGRESS",       to: "DELIVERED",         triggeredBy: "SELLER",  condition: "LEGACY: seller marks delivered" },
  { from: "DELIVERED",         to: "RELEASE_PENDING",   triggeredBy: "BUYER",   condition: "LEGACY: buyer confirms receipt" },
  { from: "RELEASE_PENDING",   to: "COMPLETED",         triggeredBy: "SYSTEM",  condition: "LEGACY: ledger transfer executed" },
  { from: "IN_PROGRESS",       to: "DISPUTED",          triggeredBy: "BUYER",   condition: "LEGACY: buyer opens dispute" },
  { from: "IN_PROGRESS",       to: "DISPUTED",          triggeredBy: "SELLER",  condition: "LEGACY: seller opens dispute" },
  { from: "RELEASE_PENDING",   to: "DISPUTED",          triggeredBy: "BUYER",   condition: "LEGACY: buyer opens dispute" },
  { from: "RELEASE_PENDING",   to: "DISPUTED",          triggeredBy: "SELLER",  condition: "LEGACY: seller opens dispute" },
  { from: "AWAITING_FUNDING",  to: "EXPIRED",           triggeredBy: "SYSTEM",  condition: "LEGACY: funding timeout" },
  { from: "AWAITING_FUNDING",  to: "CANCELLED",         triggeredBy: "BUYER",   condition: "LEGACY: buyer cancels before funding" },
  { from: "AWAITING_FUNDING",  to: "CANCELLED",         triggeredBy: "SELLER",  condition: "LEGACY: seller cancels before funding" },
];

// Build lookup map for O(1) validation
const transitionMap = new Map<string, StateTransition[]>();
for (const t of transitions) {
  const key = `${t.from}:${t.triggeredBy}`;
  if (!transitionMap.has(key)) transitionMap.set(key, []);
  transitionMap.get(key)!.push(t);
}

export function canTransition(
  from: DealStatus,
  to: DealStatus,
  triggeredBy: "BUYER" | "SELLER" | "SYSTEM" | "ADMIN"
): StateTransition | null {
  const key = `${from}:${triggeredBy}`;
  const validTargets = transitionMap.get(key);
  if (!validTargets) return null;
  return validTargets.find((t) => t.to === to) ?? null;
}

export function getNextStates(
  from: DealStatus,
  triggeredBy: "BUYER" | "SELLER" | "SYSTEM" | "ADMIN"
): DealStatus[] {
  const key = `${from}:${triggeredBy}`;
  return (transitionMap.get(key) ?? []).map((t) => t.to);
}

/**
 * States from which a dispute can be opened (after payment is manually
 * verified). Legacy states IN_PROGRESS / RELEASE_PENDING kept for old rows.
 */
export const DISPUTABLE_STATES: ReadonlySet<DealStatus> = new Set([
  "FUNDED",
  "DELIVERED",
  "RELEASE_REQUESTED",
  "REFUND_REQUESTED",
  // legacy
  "IN_PROGRESS",
  "RELEASE_PENDING",
]);

export const ACTIVE_STATES: ReadonlySet<DealStatus> = new Set([
  "CREATED",
  "JOINED",
  "AWAITING_PAYMENT",
  "PAYMENT_REPORTED",
  "FUNDED",
  "DELIVERED",
  "RELEASE_REQUESTED",
  "REFUND_REQUESTED",
  "DISPUTED",
  "UNDER_REVIEW",
  // legacy
  "AWAITING_FUNDING",
  "IN_PROGRESS",
  "RELEASE_PENDING",
]);

export const TERMINAL_STATES: ReadonlySet<DealStatus> = new Set([
  "COMPLETED",
  "REFUNDED",
  "RELEASED",
  "CANCELLED",
  "EXPIRED",
]);

/**
 * States where deals can be expired by the system.
 */
export const EXPIRABLE_STATES: ReadonlySet<DealStatus> = new Set([
  "CREATED",
  "JOINED",
  "AWAITING_PAYMENT",
  // legacy
  "AWAITING_FUNDING",
]);
