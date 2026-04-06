# syntax=docker/dockerfile:1.6

# --- Base ---
FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /src

# --- Dependencies ---
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci

# --- Builder ---
FROM base AS builder
ENV NODE_ENV=production

COPY --from=deps /src/node_modules ./node_modules
COPY . .

RUN npm run build
RUN npm prune --omit=dev

# --- Runner ---
FROM node:20-alpine AS runner
WORKDIR /src

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8005

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -G nodejs -u 1001

COPY --from=builder /src/.next ./.next
COPY --from=builder /src/public ./public
COPY --from=builder /src/package.json ./package.json
COPY --from=builder /src/node_modules ./node_modules
COPY --from=builder /src/next.config.mjs ./next.config.mjs

# Create data dir for runtime file persistence (zendesk tickets, session state)
RUN mkdir -p /src/data && chown -R nextjs:nodejs /src/data

USER nextjs
EXPOSE 8005
CMD ["npm", "run", "start"]

