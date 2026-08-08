import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";
import type { DetectedTransaction } from "../types/index.js";

const TRONGRID_BASE = "https://api.trongrid.io";

/**
 * TRON TRC20 Service
 *
 * Uses Trongrid API to:
 *   1. Query TRC20 transfer events to monitored addresses
 *   2. Get transaction details and confirmations
 *   3. Validate deposits
 */
export const tronService = {
  /**
   * Fetch TRC20 transfers TO a specific address.
   * Uses the /v1/accounts/{address}/transactions/trc20 endpoint.
   */
  async getTrc20Transfers(address: string, contractAddress?: string, minTimestamp?: number) {
    const params = new URLSearchParams({
      only_to: "true",
      limit: "50",
      contract_address: contractAddress ?? config.tron.usdtContract,
    });

    if (minTimestamp) {
      params.set("min_timestamp", minTimestamp.toString());
    }

    const url = `${TRONGRID_BASE}/v1/accounts/${address}/transactions/trc20?${params}`;
    const headers: Record<string, string> = {
      "Accept": "application/json",
    };
    if (config.tron.apiKey) {
      headers["TRON-PRO-API-KEY"] = config.tron.apiKey;
    }

    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Trongrid error ${resp.status}: ${body}`);
    }

    const data = await resp.json() as {
      data?: Array<{
        transaction_id: string;
        block_timestamp: number;
        from: string;
        to: string;
        value: string;
        type: string;
        token_info?: { symbol: string; address: string; decimals: number };
      }>;
    };

    return data.data ?? [];
  },

  /**
   * Get transaction info including current block and confirmations.
   */
  async getTransactionInfo(txId: string) {
    const url = `${TRONGRID_BASE}/v1/transactions/${txId}?verbose=true`;
    const headers: Record<string, string> = {};
    if (config.tron.apiKey) {
      headers["TRON-PRO-API-KEY"] = config.tron.apiKey;
    }

    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      throw new Error(`Trongrid TX lookup error ${resp.status}`);
    }

    return resp.json() as Promise<{
      txID: string;
      blockNumber?: number;
      ret?: { contractRet: string };
    }>;
  },

  /**
   * Get the current latest solidified block number.
   */
  async getLatestBlock(): Promise<number> {
    const url = `${TRONGRID_BASE}/v1/blocks?limit=1&sort=-timestamp`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("Failed to get latest block");
    const data = await resp.json() as { data?: Array<{ block_number: number }> };
    return data.data?.[0]?.block_number ?? 0;
  },

  /**
   * Parse a TRC20 transfer event into our standard DetectedTransaction format.
   */
  parseTrc20Transfer(transfer: {
    transaction_id: string;
    from: string;
    to: string;
    value: string;
    token_info?: { symbol: string; decimals: number };
  }, latestBlock: number, txBlockNumber?: number): DetectedTransaction {
    const decimals = transfer.token_info?.decimals ?? 6;
    const rawAmount = BigInt(transfer.value);
    const amount = (Number(rawAmount) / Math.pow(10, decimals)).toFixed(decimals);

    const confirmations = txBlockNumber && latestBlock > txBlockNumber
      ? latestBlock - txBlockNumber
      : 0;

    return {
      txHash: transfer.transaction_id,
      fromAddress: transfer.from,
      toAddress: transfer.to,
      token: transfer.token_info?.symbol ?? "USDT",
      amount,
      blockNumber: txBlockNumber ?? 0,
      confirmations,
      network: "TRC20",
    };
  },
};
