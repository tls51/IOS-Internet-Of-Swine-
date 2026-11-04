# ============================================================
# Production Dockerfile for Internet of Swine (IoS) Backend & Dashboard
# ============================================================

# Step 1: Builder stage with native build toolchain for better-sqlite3
FROM node:20-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY ios-backend/package*.json ./ios-backend/
WORKDIR /app/ios-backend
RUN npm ci --omit=dev

# Step 2: Lightweight production runner
FROM node:20-slim AS runner

WORKDIR /app

# Ensure persistent mount directory exists
RUN mkdir -p /data

# Copy production node_modules from builder
COPY --from=builder /app/ios-backend/node_modules ./ios-backend/node_modules

# Copy application source and frontend dashboard
COPY ios-backend ./ios-backend
COPY dashboard ./dashboard

ENV NODE_ENV=production \
    PORT=3000 \
    IOS_DB_PATH=/data/ios.db \
    IOS_DASHBOARD_PATH=/app/dashboard

EXPOSE 3000

WORKDIR /app/ios-backend
CMD ["node", "src/server.js"]
