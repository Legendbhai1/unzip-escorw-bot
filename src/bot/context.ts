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
  createDealCryptoPayer?: "BUYER" | "SELLER";
  createDealDescription?: string;
  createDealCategory?: string;
  createDealDuration?: string;
  createDealReleaseCondition?: string;
  createDealRefundCondition?: string;
  // Group the deal form was started in (an APPROVED escrow group). The
  // finished deal card is posted to THIS group — the group where the form
  // ran is the deal's home (group-first). Unset for DM-started forms, which
  // fall back to the configured escrow group / first approved group.
  createDealTargetGroupId?: string;

  // Last deal this user viewed/interacted with — used to resolve /release
  // and /refund in DM when no deal message is replied to.
  lastDealId?: string;

  // Admin: which payment setting is being edited (upi_id / upi_name / …)
  pendingSettingKey?: string;
  // Admin: the group whose payment setting is being edited ("" = global).
  pendingSettingGroupId?: string;
  // Admin: capturing an optional refund reference after marking refunded
  pendingRefundReferenceDealId?: string;

  // ── Flow/state hardening ──────────────────────────────────────
  // ONE authoritative interactive flow per user. `flowToken` is a version
  // token rotated on every step advance — button callbacks embed the token
  // they were rendered with, so stale buttons from older messages are
  // rejected. `flowChatId` binds free-text input to the chat where the flow
  // started (text in another chat is never consumed by this flow).
  // `flowExpiresAt` expires abandoned flows so old questions stop consuming
  // input after a TTL.
  flowToken?: string;
  flowChatId?: string;
  flowExpiresAt?: number;
  // The chat a pending text-capture state started in (payment report,
  // evidence, reject reason, references, setting value). Text is only
  // consumed in the same chat the prompt was sent to.
  pendingFlowChatId?: string;

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
