# syntax=docker/dockerfile:1.6

# --- Base stage ---
FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /src

# --- Dependencies stage ---
FROM base AS deps
COPY package.json ./
RUN npm i
RUN npm ci

# --- Build stage ---
FROM base AS builder
ENV NODE_ENV=production

# Copy node_modules from deps
#COPY --from=deps /src/node_modules ./node_modules

# Copy the rest of the app source
COPY . .

# Build the app
RUN npm run build

# Remove devDependencies before copying to the runtime image
RUN npm prune --omit=dev

# --- Runtime stage ---
FROM node:20-alpine AS runner
WORKDIR /src

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8005

# Add a non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -G nodejs -u 1001

# Copy only necessary runtime files
COPY --from=builder /src/.next ./.next
COPY --from=builder /src/public ./public
COPY --from=builder /src/package.json ./package.json
COPY --from=builder /src/next.config.mjs ./next.config.mjs
COPY --from=builder /src/node_modules ./node_modules

USER nextjs
EXPOSE 8005
CMD ["npm", "run", "start"]

