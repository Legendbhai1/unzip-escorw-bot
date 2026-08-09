import { Context } from "grammy";

export interface SessionData {
  userId: string;
  telegramId: number;
  username: string | null;
  firstName: string;
  pendingJoinDealId?: string;
  pendingDisputeDealId?: string;

  // ── Deal form (one canonical flow for [Create Deal] / /form / "form") ──
  createDealStep?: string; // payment_method | role | counterparty | amount | crypto_network | category | description | preview
  createDealPaymentMethod?: "INR" | "CRYPTO";
  createDealRole?: "buyer" | "seller";
  createDealCounterpartyUsername?: string;
  createDealCounterpartyUserId?: string | null;
  createDealAmount?: string;
  createDealAsset?: string;
  createDealNetwork?: string;
  createDealDescription?: string;
  createDealCategory?: string;

  // ── Manual payment flow state ──
  // Buyer: awaiting payment reference / evidence after clicking "I've Paid"
  pendingPaymentReportDealId?: string;
  // Buyer: submitting evidence at the escrower's request
  pendingEvidenceDealId?: string;
  // Admin: capturing optional payment / payout reference after acting
  pendingPaymentReferenceDealId?: string;
  pendingPayoutReferenceDealId?: string;
  // Admin: capturing a rejection reason
  pendingRejectPaymentDealId?: string;
}

export type MyContext = Context & { session: SessionData };
