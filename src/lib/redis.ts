import Redis from "ioredis";
import { config } from "../config/index.js";

const globalForRedis = globalThis as unknown as { redis: Redis };

export const redis =
  globalForRedis.redis ??
  new Redis(config.redisUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    // Do not retry the connection forever: the bot explicitly supports an
    // in-memory session fallback when Redis is unavailable, and an endless
    // reconnect loop would spam "[ioredis] Unhandled error event" every few
    // seconds. connect() failures are handled by the caller.
    retryStrategy: () => null,
  });

// Consume connection error events. Without a listener ioredis prints an
// "[ioredis] Unhandled error event" stack trace on every failed attempt;
// the caller handles connect() failures by falling back to in-memory sessions.
redis.on("error", () => {});

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redis = redis;
}

// Rate limiting helper
export async function checkRateLimit(
  key: string,
  windowMs: number,
  maxRequests: number
): Promise<{ allowed: boolean; remaining: number }> {
  const windowSec = Math.ceil(windowMs / 1000);
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSec);
  return { allowed: count <= maxRequests, remaining: Math.max(0, maxRequests - count) };
}
