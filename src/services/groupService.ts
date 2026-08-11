import { prisma } from "../lib/db.js";
import { config, isBotOwner } from "../config/index.js";
import { logger } from "../lib/logger.js";

/**
 * Group authorization + group-specific escrow admins.
 *
 * Only the bot owner can approve/disallow groups (/allowgroup, /disallowgroup)
 * and assign/remove group escrow admins (/addadmin, /removeadmin, /groupadmins).
 * Authorization for every sensitive group action is checked SERVER-SIDE against
 * these persisted rows — never against Telegram's own group-admin flags and
 * never by trusting callback data.
 *
 * Authorization rule for a group-scoped escrow action:
 *   bot owner  OR  an ACTIVE escrow admin assigned to THAT SPECIFIC group.
 * Global admins (ADMIN_TELEGRAM_IDS) keep their existing full powers.
 */
export const groupService = {
  // ── Group approval ─────────────────────────────────────────────
  async isGroupApproved(groupId: string): Promise<boolean> {
    try {
      const row = await prisma.groupAuthorization.findUnique({ where: { groupId } });
      return row?.status === "APPROVED";
    } catch {
      return false;
    }
  },

  /**
   * Approve (or re-approve) a group. Upserts so re-running /allowgroup is
   * idempotent; re-approving clears any previous disallow state.
   */
  async approveGroup(groupId: string, groupTitle: string | undefined, allowedByUserId: string) {
    const row = await prisma.groupAuthorization.upsert({
      where: { groupId },
      create: {
        groupId,
        groupTitle: groupTitle ?? null,
        status: "APPROVED",
        allowedBy: allowedByUserId,
        allowedAt: new Date(),
        disallowedBy: null,
        disallowedAt: null,
      },
      update: {
        groupTitle: groupTitle ?? undefined,
        status: "APPROVED",
        allowedBy: allowedByUserId,
        allowedAt: new Date(),
        disallowedBy: null,
        disallowedAt: null,
      },
    });
    logger.info({ groupId, allowedByUserId }, "Group approved for escrow operations");
    return row;
  },

  /**
   * Disallow escrow operations in a group. NEVER deletes deals, users or audit
   * records — the group row is kept with status DISALLOWED so history remains.
   */
  async disallowGroup(groupId: string, disallowedByUserId: string) {
    const existing = await prisma.groupAuthorization.findUnique({ where: { groupId } });
    if (!existing) {
      // Keep the disallowed row so an owner can later re-approve with history.
      await prisma.groupAuthorization.create({
        data: {
          groupId,
          status: "DISALLOWED",
          disallowedBy: disallowedByUserId,
          disallowedAt: new Date(),
        },
      });
    } else {
      await prisma.groupAuthorization.update({
        where: { groupId },
        data: {
          status: "DISALLOWED",
          disallowedBy: disallowedByUserId,
          disallowedAt: new Date(),
        },
      });
    }
    logger.info({ groupId, disallowedByUserId }, "Group disallowed for escrow operations");
  },

  /** First approved group — fallback target when ESCROW_GROUP_ID is unset. */
  async getFirstApprovedGroupId(): Promise<string | null> {
    const row = await prisma.groupAuthorization.findFirst({
      where: { status: "APPROVED" },
      orderBy: { allowedAt: "asc" },
    });
    return row?.groupId ?? null;
  },

  // ── Group escrow admins ─────────────────────────────────────────
  /** Is this Telegram user an ACTIVE escrow admin for this group? */
  async isActiveGroupAdmin(groupId: string, telegramId: bigint): Promise<boolean> {
    const row = await prisma.groupAdmin.findFirst({
      where: { groupId, status: "ACTIVE", user: { telegramId } },
      select: { id: true },
    });
    return Boolean(row);
  },

  /** Is this Telegram user an ACTIVE escrow admin for the deal's group? */
  async isActiveGroupAdminForDeal(groupId: string | null | undefined, telegramId: bigint): Promise<boolean> {
    if (!groupId) return false;
    return this.isActiveGroupAdmin(groupId, telegramId);
  },

  /**
   * Assign a user as escrow admin for a group. Idempotent: re-assigning
   * reactivates a previously removed assignment instead of creating a second
   * active row (the groupId+userId unique index guarantees one row).
   */
  async addGroupAdmin(groupId: string, userId: string, assignedByUserId: string) {
    const row = await prisma.groupAdmin.upsert({
      where: { groupId_userId: { groupId, userId } },
      create: { groupId, userId, assignedBy: assignedByUserId, status: "ACTIVE", removedAt: null },
      update: {
        assignedBy: assignedByUserId,
        assignedAt: new Date(),
        status: "ACTIVE",
        removedAt: null,
      },
    });
    logger.info({ groupId, userId, assignedByUserId }, "Group escrow admin assigned");
    return row;
  },

  /** Remove a user as escrow admin for a group (soft remove, history kept). */
  async removeGroupAdmin(groupId: string, userId: string, removedByUserId: string) {
    const res = await prisma.groupAdmin.updateMany({
      where: { groupId, userId, status: "ACTIVE" },
      data: { status: "REMOVED", removedAt: new Date() },
    });
    if (res.count > 0) {
      logger.info({ groupId, userId, removedByUserId }, "Group escrow admin removed");
    }
    return res.count;
  },

  async listGroupAdmins(groupId: string) {
    return prisma.groupAdmin.findMany({
      where: { groupId, status: "ACTIVE" },
      include: { user: true },
      orderBy: { assignedAt: "asc" },
    });
  },

  // ── Authorization helpers (server-side, used by every sensitive action) ──
  /**
   * Can this Telegram user perform escrow admin actions for this group?
   * Bot owner OR global admin OR ACTIVE group escrow admin for THIS group.
   */
  async isAuthorizedForGroup(telegramId: number, groupId: string | null | undefined): Promise<boolean> {
    if (!groupId) return false;
    if (isBotOwner(telegramId)) return true;
    if (config.adminTelegramIds.has(telegramId)) return true;
    return this.isActiveGroupAdmin(groupId, BigInt(telegramId));
  },
};
