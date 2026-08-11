/**
 * Escape a value for safe interpolation into a Telegram HTML message.
 *
 * The bot sends messages with parse_mode = "HTML" (see the global API
 * transformer in bot/index.ts). Any user-provided text that is interpolated
 * into such a message MUST be escaped here, otherwise a stray `<`, `>` or `&`
 * would either break Telegram's entity parsing (HTTP 400) or allow a user to
 * inject HTML entities into messages shown to other users.
 */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Build a clickable Telegram user mention (`tg://user?id=…`) for HTML-mode
 * messages. In groups a plain `@username` is only a link when the bot is an
 * admin AND the user has a public username; `tg://user` links always work.
 * Falls back to a plain @username (escaped) when the numeric id is unknown.
 */
export function userMention(
  telegramId: bigint | number | string | null | undefined,
  username: string | null | undefined,
  fallback = "N/A"
): string {
  const label = username ? `@${esc(username)}` : esc(fallback);
  if (telegramId === null || telegramId === undefined || telegramId === "") return label;
  return `<a href="tg://user?id=${String(telegramId)}">${label}</a>`;
}
