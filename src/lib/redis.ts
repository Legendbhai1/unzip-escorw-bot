import Redis from "ioredis";
import { config } from "../config/index.js";

const globalForRedis = globalThis as unknown as { redis: Redis };

export const redis =
  globalForRedis.redis ??
  new Redis(config.redisUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });

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
