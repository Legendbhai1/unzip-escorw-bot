import { DealStatus } from "@prisma/client";
import type { StateTransition } from "../types/index.js";

// ─── Valid Transitions ─────────────────────────────────────────────────
// Single source of truth. Every deal status change MUST pass canTransition().

const transitions: StateTransition[] = [
  // Happy path
  { from: "CREATED",          to: "JOINED",            triggeredBy: "SELLER",  condition: "Seller accepts invite" },
  { from: "JOINED",           to: "AWAITING_DEPOSIT",  triggeredBy: "SYSTEM",  condition: "Both parties accepted" },
  { from: "AWAITING_DEPOSIT", to: "FUNDED",            triggeredBy: "SYSTEM",  condition: "Buyer balance locked" },
  { from: "FUNDED",           to: "IN_PROGRESS",       triggeredBy: "SYSTEM",  condition: "Auto or manual start" },
  { from: "IN_PROGRESS",      to: "DELIVERED",         triggeredBy: "SELLER",  condition: "Seller marks delivered" },
  { from: "FUNDED",           to: "DELIVERED",         triggeredBy: "SELLER",  condition: "Seller marks delivered directly" },
  { from: "DELIVERED",        to: "RELEASE_PENDING",   triggeredBy: "BUYER",   condition: "Buyer confirms receipt" },
  { from: "RELEASE_PENDING",  to: "RELEASED",          triggeredBy: "SYSTEM",  condition: "Ledger transfer executed" },
  { from: "RELEASED",         to: "COMPLETED",         triggeredBy: "SYSTEM",  condition: "Final cleanup" },

  // Dispute path — allowed from FUNDED, IN_PROGRESS, DELIVERED, RELEASE_PENDING
  { from: "FUNDED",           to: "DISPUTED",          triggeredBy: "BUYER",   condition: "Buyer opens dispute" },
  { from: "FUNDED",           to: "DISPUTED",          triggeredBy: "SELLER",  condition: "Seller opens dispute" },
  { from: "IN_PROGRESS",      to: "DISPUTED",          triggeredBy: "BUYER",   condition: "Buyer opens dispute" },
  { from: "IN_PROGRESS",      to: "DISPUTED",          triggeredBy: "SELLER",  condition: "Seller opens dispute" },
  { from: "DELIVERED",        to: "DISPUTED",          triggeredBy: "BUYER",   condition: "Buyer opens dispute" },
  { from: "RELEASE_PENDING",  to: "DISPUTED",          triggeredBy: "BUYER",   condition: "Buyer opens dispute" },
  { from: "RELEASE_PENDING",  to: "DISPUTED",          triggeredBy: "SELLER",  condition: "Seller opens dispute" },

  // Admin dispute resolution
  { from: "DISPUTED",         to: "UNDER_REVIEW",      triggeredBy: "ADMIN",   condition: "Admin begins review" },
  { from: "UNDER_REVIEW",     to: "RELEASED",          triggeredBy: "ADMIN",   condition: "Release to seller" },
  { from: "UNDER_REVIEW",     to: "REFUNDED",          triggeredBy: "ADMIN",   condition: "Refund buyer" },

  // Refunded/Released -> COMPLETED
  { from: "REFUNDED",         to: "COMPLETED",         triggeredBy: "SYSTEM",  condition: "Refund finalized" },

  // Cancel path (pre-funded only — NEVER touch ledger)
  { from: "CREATED",          to: "CANCELLED",         triggeredBy: "BUYER",   condition: "Buyer cancels before join" },
  { from: "JOINED",           to: "CANCELLED",         triggeredBy: "BUYER",   condition: "Mutual agreement" },
  { from: "JOINED",           to: "CANCELLED",         triggeredBy: "SELLER",  condition: "Mutual agreement" },
  { from: "AWAITING_DEPOSIT", to: "CANCELLED",         triggeredBy: "BUYER",   condition: "Buyer cancels before funding" },
  { from: "AWAITING_DEPOSIT", to: "CANCELLED",         triggeredBy: "SELLER",  condition: "Seller cancels before funding" },
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
 * States from which a dispute can be opened.
 * FUNDED, IN_PROGRESS, DELIVERED, RELEASE_PENDING
 */
export const DISPUTABLE_STATES: ReadonlySet<DealStatus> = new Set([
  "FUNDED",
  "IN_PROGRESS",
  "DELIVERED",
  "RELEASE_PENDING",
]);

export const ACTIVE_STATES: ReadonlySet<DealStatus> = new Set([
  "CREATED",
  "JOINED",
  "AWAITING_DEPOSIT",
  "FUNDED",
  "IN_PROGRESS",
  "DELIVERED",
  "RELEASE_PENDING",
  "DISPUTED",
  "UNDER_REVIEW",
]);

export const TERMINAL_STATES: ReadonlySet<DealStatus> = new Set([
  "COMPLETED",
  "REFUNDED",
  "CANCELLED",
]);
