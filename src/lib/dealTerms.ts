/**
 * Parse a free-text deal duration ("7 days", "48 hours", "30 days") into a
 * deadline timestamp. Returns null when unparseable — the text is still
 * displayed, but no deadline is tracked.
 *
 * IMPORTANT: the deadline is informational ONLY. The bot never auto-refunds
 * or auto-releases money when it passes — the existing dispute/refund process
 * handles overdue deals.
 */
export function parseDurationDeadline(text: string): Date | null {
  const m = String(text ?? "").toLowerCase().match(
    /(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|s|m|h|d|w|mo|y)/
  );
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  const DAY = 86_400_000;
  let ms = 0;
  if (unit.startsWith("mo")) ms = n * 30 * DAY;
  else if (unit.startsWith("y")) ms = n * 365 * DAY;
  else if (unit.startsWith("w")) ms = n * 7 * DAY;
  else if (unit.startsWith("d")) ms = n * DAY;
  else if (unit.startsWith("h")) ms = n * 3_600_000;
  else if (unit.startsWith("m")) ms = n * 60_000;
  else if (unit.startsWith("s")) ms = n * 1000;
  else return null;
  if (ms <= 0 || ms > 365 * DAY) return null;
  return new Date(Date.now() + ms);
}
