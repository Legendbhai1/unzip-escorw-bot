import { treasuryService } from "./treasuryService.js";

/**
 * Wallet Service — READ-ONLY facade.
 * All balance mutations go through treasuryService.
 * This exists for convenience queries only.
 */
export const walletService = {
  async getBalance(userId: string, asset: string) {
    return treasuryService.getBalance(userId, asset);
  },

  async getAllBalances(userId: string) {
    return treasuryService.getAllBalances(userId);
  },
};
