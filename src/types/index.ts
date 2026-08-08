// ─── Re-export Prisma enums for app-level use ─────────────────────────────
import type {
  DealStatus, DealRole, DealCategory,
  TransactionType, TransactionStatus,
  DisputeStatus, DisputeResolution,
  UserStatus, LedgerEntryType, ReferenceType, AdminActionType,
} from "@prisma/client";

export type {
  DealStatus, DealRole, DealCategory,
  TransactionType, TransactionStatus,
  DisputeStatus, DisputeResolution,
  UserStatus, LedgerEntryType, ReferenceType, AdminActionType,
};

// ─── State Machine Transitions ───────────────────────────────────────────
export interface StateTransition {
  from: DealStatus;
  to: DealStatus;
  triggeredBy: "BUYER" | "SELLER" | "SYSTEM" | "ADMIN";
  condition?: string;
}

// ─── Ledger Operations ──────────────────────────────────────────────────
export interface LedgerOperation {
  userId: string;
  dealId?: string;
  type: LedgerEntryType;
  amount: string; // Decimal as string to avoid float issues
  asset: string;
  referenceType?: ReferenceType;
  referenceId?: string;
  idempotencyKey: string;
}

// ─── Blockchain Deposit Detection ────────────────────────────────────────
export interface DetectedTransaction {
  txHash: string;
  fromAddress: string;
  toAddress: string;
  token: string;
  amount: string;
  blockNumber: number;
  confirmations: number;
  network: string;
  logIndex?: number;
}

// ─── Supported Networks ─────────────────────────────────────────────────
export interface NetworkConfig {
  name: string;
  code: string;       // TRC20, BEP20, BTC, etc.
  assets: string[];   // USDT, USDC, etc.
  minConfirmations: number;
  pollIntervalMs: number;
  rpcUrl?: string;
  apiKey?: string;
  contractAddress?: Record<string, string>; // asset -> contract address
}

// ─── Deal Creation DTO ─────────────────────────────────────────────────
export interface CreateDealInput {
  buyerTelegramId: number;
  sellerUsername: string;
  amount: string;
  asset: string;
  network: string;
  description: string;
  category: DealCategory;
}

// ─── Withdrawal Request ─────────────────────────────────────────────────
export interface WithdrawalRequest {
  userId: string;
  asset: string;
  amount: string;
  toAddress: string;
  network: string;
}
