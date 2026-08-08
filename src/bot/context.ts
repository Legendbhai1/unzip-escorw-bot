import { Context } from "grammy";

export interface SessionData {
  userId: string;
  telegramId: number;
  username: string | null;
  firstName: string;
  pendingJoinDealId?: string;
  pendingDisputeDealId?: string;
  createDealStep?: string;
  createDealRole?: "buyer" | "seller";
  createDealCounterpartyUsername?: string;
  createDealCounterpartyUserId?: string | null;
  createDealAmount?: string;
  createDealAsset?: string;
  createDealNetwork?: string;
  createDealDescription?: string;
  createDealCategory?: string;
  depositNetwork?: string;
}

export type MyContext = Context & { session: SessionData };
