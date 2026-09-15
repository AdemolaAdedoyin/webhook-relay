# --- deps & build ---
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Prisma needs OpenSSL available while generating/running its native engine.
# Debian slim keeps the runtime portable across amd64 and arm64 Docker hosts.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npm run prisma:generate
RUN npm run build

# --- one-off migrations ---
# Keep Prisma CLI/dev dependencies here instead of the production runtime.
FROM builder AS migrator
CMD ["npm", "run", "prisma:deploy"]

# --- local/demo seeding ---
# The seed command uses tsx, so keep it on the builder image rather than
# re-introducing development dependencies into the production runtime.
FROM builder AS seeder
CMD ["npm", "run", "seed"]

# --- runtime ---
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma
COPY --from=builder /app/node_modules ./node_modules
RUN npm prune --omit=dev
# Preserve the Prisma client/engine generated for this container architecture.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/dist ./dist

USER node

EXPOSE 3000
CMD ["node", "dist/index.js"]
