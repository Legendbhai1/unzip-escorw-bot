/**
 * Create Deal scene types.
 * The actual create-deal flow is handled inline in bot/index.ts
 * using session state + callback queries.
 */

export type DealDraft = {
  role: "buyer" | "seller";
  counterpartyUsername: string;
  counterpartyUserId: string | null;
  amount: string;
  asset: string;
  network: string;
  description: string;
  category: string;
};
