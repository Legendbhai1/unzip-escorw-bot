/**
 * Format an amount for display in the bot.
 * - INR: ₹ with en-IN grouping and 2 decimals (e.g. ₹10,000.00)
 * - Everything else: "<amount> <symbol>" with up to 8 decimals trimmed.
 */
export function formatMoney(amount: string | number, currencyOrAsset: string): string {
  const value = typeof amount === "number" ? amount : parseFloat(amount);
  if (Number.isNaN(value)) return `${amount} ${currencyOrAsset}`;

  if (currencyOrAsset.toUpperCase() === "INR") {
    return `₹${value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  const trimmed = parseFloat(value.toFixed(8)).toString();
  return `${trimmed} ${currencyOrAsset}`;
}

/**
 * Fee label helper: "1%" or "0.5%" from basis points.
 */
export function bpsToPercent(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}
