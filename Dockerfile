# ==========================
# Stage 1: Build
# ==========================
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install all dependencies (including devDependencies)
RUN npm ci

# Copy source code
COPY . .

# Build NestJS application
RUN npm run build

# ==========================
# Stage 2: Production
# ==========================
FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev && npm cache clean --force

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Copy any required runtime files
COPY --from=builder /app/.env* ./

EXPOSE 3000

CMD ["node", "dist/main.js"]
