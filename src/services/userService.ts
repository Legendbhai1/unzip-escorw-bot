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

  async findByUsername(username: string) {
    return prisma.user.findFirst({
      where: { username: username.replace("@", "") },
    });
  },

  async ensureActive(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error("User not found");
    if (user.status !== "ACTIVE") throw new Error(`User account is ${user.status.toLowerCase()}`);
    return user;
  },
};
