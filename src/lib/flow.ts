import { randomUUID } from "node:crypto";

/**
 * Flow/state hardening helpers.
 *
 * The bot's multi-step flows (deal form, payment report capture, evidence
 * capture, admin settings) are keyed per-user. To stop STALE buttons and STALE
 * text from hijacking a flow, every interactive flow gets:
 *   - a version TOKEN embedded in the callback data of the buttons it renders
 *     (rotated on every step advance — old buttons carry an old token and are
 *     rejected), and
 *   - a CHAT binding — free text is only consumed in the chat where the flow
 *     started, never in another chat, and
 *   - an EXPIRY — abandoned flows stop consuming input after a TTL.
 */

/** How long an unattended multi-step flow stays authoritative (30 min). */
export const FLOW_TTL_MS = 30 * 60 * 1000;

/** Generate a fresh, unguessable flow version token. */
export function newFlowToken(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

/** True when a flow started at `startedAt` (epoch ms) has expired. */
export function isFlowExpired(startedAt: number | undefined, now: number = Date.now()): boolean {
  if (startedAt == null) return false;
  return now - startedAt > FLOW_TTL_MS;
}

/**
 * May a flow bound to `flowChatId` consume a message from `chatId`? A flow
 * only consumes text in the chat where it started — messages typed anywhere
 * else are never interpreted by an old question.
 */
export function isFlowChatValid(flowChatId: string | undefined, chatId: string | undefined): boolean {
  if (!flowChatId) return true;
  return String(chatId ?? "") === flowChatId;
}

/**
 * Is a callback coming from an acceptable chat for a deal-scoped action?
 * Deal callbacks must come from the deal's own group OR from a private chat
 * (the bot sends DM buttons to the parties/admins). A callback crafted in or
 * forwarded from ANY OTHER group is invalid — it can never act on the deal.
 */
export function isDealChatValid(
  chatType: string | undefined,
  chatId: number | string | undefined,
  dealGroupChatId: string | null | undefined
): boolean {
  if (chatId == null) return true; // callback without a message context — let the service re-check auth
  if (chatType === "private") return true;
  if (!dealGroupChatId) return true; // deal not posted to a group yet — nothing to cross-check
  return String(chatId) === String(dealGroupChatId);
}

/**
 * Callback version tokens are appended to interactive button data as a
 * `:v<token>` suffix (see dealForm.ts). Splits a callback string into its
 * action and, when present, the token it was rendered with.
 */
export function splitCallbackToken(data: string): { action: string; token: string | null } {
  const i = data.lastIndexOf(":v");
  if (i > 0) {
    const token = data.slice(i + 2);
    if (/^[A-Za-z0-9]{6,16}$/.test(token)) {
      return { action: data.slice(0, i), token };
    }
  }
  return { action: data, token: null };
}
