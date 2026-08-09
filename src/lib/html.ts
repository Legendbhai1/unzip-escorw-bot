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
