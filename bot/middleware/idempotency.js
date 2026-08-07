// In-memory de-dupe of callback_query IDs. Telegram guarantees uniqueness per callback
// press, so this blocks double-taps / retried webhook deliveries from double-processing
// a button. A single-process in-memory Set is sufficient here; for multi-instance
// deployments swap this for a shared store (e.g. a Postgres unique constraint).
const seen = new Map();
const TTL_MS = 5 * 60 * 1000;

function cleanup() {
  const now = Date.now();
  for (const [id, ts] of seen) {
    if (now - ts > TTL_MS) seen.delete(id);
  }
}

async function dedupeCallback(ctx, next) {
  const cq = ctx.callbackQuery;
  if (!cq) return next();
  if (seen.has(cq.id)) {
    await ctx.answerCbQuery('Already processed.');
    return;
  }
  seen.set(cq.id, Date.now());
  if (seen.size % 200 === 0) cleanup();
  return next();
}

// Simple per-user rate limiter for sensitive commands (e.g. /form, admin actions).
const lastAction = new Map();
function rateLimit(minMs = 1500) {
  return (ctx, next) => {
    const id = ctx.from && ctx.from.id;
    if (!id) return next();
    const now = Date.now();
    const last = lastAction.get(id) || 0;
    if (now - last < minMs) {
      if (ctx.answerCbQuery) return ctx.answerCbQuery('Please slow down.');
      return;
    }
    lastAction.set(id, now);
    return next();
  };
}

module.exports = { dedupeCallback, rateLimit };
