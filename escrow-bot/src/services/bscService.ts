import { JsonRpcProvider, Contract } from "ethers";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";
import type { DetectedTransaction } from "../types/index.js";

// Standard ERC20 Transfer event ABI
const ERC20_TRANSFER_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

// ERC20 balanceOf + decimals ABI for optional checks
const ERC20_BALANCE_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

let provider: JsonRpcProvider | null = null;
let usdtContract: Contract | null = null;

function getProvider(): JsonRpcProvider {
  if (!provider) {
    provider = new JsonRpcProvider(config.bsc.rpcUrl);
  }
  return provider;
}

function getUsdtContract(): Contract {
  if (!usdtContract) {
    usdtContract = new Contract(
      config.bsc.usdtContract,
      ERC20_TRANSFER_ABI,
      getProvider()
    );
  }
  return usdtContract;
}

/**
 * Get USDT decimals from the contract (usually 18 on BSC).
 */
async function getDecimals(): Promise<number> {
  try {
    const c = new Contract(config.bsc.usdtContract, ERC20_BALANCE_ABI, getProvider());
    return await c.decimals();
  } catch {
    return 18; // BSC USDT uses 18 decimals
  }
}

/**
 * Get the current block number.
 */
export const bscService = {
  /**
   * Fetch ERC20 (BEP20) Transfer events to a specific address within a block range.
   * Uses ethers.js getLogs which is efficient and free (no API key needed).
   */
  async getBep20Transfers(
    toAddress: string,
    fromBlock: number,
    toBlock: number
  ): Promise<DetectedTransaction[]> {
    const contract = getUsdtContract();
    const decimals = await getDecimals();
    const currentBlock = await getProvider().getBlockNumber();

    // Clamp toBlock to current block
    const safeToBlock = Math.min(toBlock, currentBlock);
    if (fromBlock > safeToBlock) return [];

    const filter = contract.filters.Transfer(null, toAddress);

    const logs = await contract.queryFilter(filter, fromBlock, safeToBlock);

    return logs.map((log) => {
      const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
      if (!parsed) return null;

      const rawAmount = parsed.args[2] as bigint;
      const amount = (Number(rawAmount) / Math.pow(10, decimals)).toFixed(decimals);
      const confirmations = currentBlock - (log.blockNumber ?? 0);

      return {
        txHash: log.transactionHash,
        fromAddress: parsed.args[0] as string,
        toAddress: parsed.args[1] as string,
        token: "USDT",
        amount,
        blockNumber: log.blockNumber ?? 0,
        confirmations: Math.max(confirmations, 0),
        network: "BEP20",
      };
    }).filter((t): t is DetectedTransaction => t !== null);
  },

  /**
   * Get the latest block number on BSC.
   */
  async getLatestBlock(): Promise<number> {
    return getProvider().getBlockNumber();
  },

  /**
   * Get a transaction receipt for confirmation count.
   */
  async getTxConfirmations(txHash: string): Promise<number> {
    const receipt = await getProvider().getTransactionReceipt(txHash);
    if (!receipt || !receipt.blockNumber) return 0;
    const current = await getProvider().getBlockNumber();
    return current - receipt.blockNumber;
  },
};
