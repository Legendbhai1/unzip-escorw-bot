FROM node:22-alpine AS base

WORKDIR /app

# Install build deps for native modules (bull, ioredis)
RUN apk add --no-cache openssl

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci --production=false

# Copy source
COPY tsconfig.json ./
COPY prisma ./prisma/
COPY src ./src/

# Generate Prisma client
RUN npx prisma generate

# Build TypeScript
RUN npx tsc

# ─── Bot process ───────────────────────────────────────────
FROM node:22-alpine AS bot

WORKDIR /app
RUN apk add --no-cache openssl tini

COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/dist ./dist
COPY --from=base /app/prisma ./prisma
COPY --from=base /app/package.json ./

# Non-root user
RUN addgroup -S escrow && adduser -S escrow -G escrow
USER escrow

EXPOSE 3000

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]

# ─── Blockchain worker ─────────────────────────────────────
FROM bot AS monitor
CMD ["node", "dist/workers/blockchain.js"]

# ─── Withdrawal worker ─────────────────────────────────────
FROM bot AS withdrawal
CMD ["node", "dist/workers/withdrawal.js"]
