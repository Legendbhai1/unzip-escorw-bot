import { prisma } from "../lib/db.js";
import { logger } from "../lib/logger.js";

export const userService = {
  /**
   * Find or create a user by Telegram ID.
   * Called on every /start or interaction.
   */
  async findOrCreate(telegramId: bigint, username: string | undefined, firstName: string) {
    return prisma.user.upsert({
      where: { telegramId },
      create: {
        telegramId,
        username: username?.replace("@", ""),
        firstName,
      },
      update: {
        ...(username ? { username: username.replace("@", "") } : {}),
        firstName,
      },
    });
  },

  async findById(userId: string) {
    return prisma.user.findUnique({ where: { id: userId } });
  },

  async findByTelegramId(telegramId: bigint) {
    return prisma.user.findUnique({ where: { telegramId } });
  },

  /**
   * Find a user by Telegram username.
   * Normalizes input (strips leading @, trims) and matches case-insensitively
   * so "@Alice", "alice" and "ALICE" all find the same user.
   */
  async findByUsername(username: string) {
    const normalized = String(username ?? "").replace(/^@+/, "").trim();
    if (!normalized) return null;
    return prisma.user.findFirst({
      where: { username: { equals: normalized, mode: "insensitive" } },
    });
  },

  async ensureActive(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error("User not found");
    if (user.status !== "ACTIVE") throw new Error(`User account is ${user.status.toLowerCase()}`);
    return user;
  },
};
