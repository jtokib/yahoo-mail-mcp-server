# Yahoo Mail MCP Server - Dockerfile
# Multi-stage build for optimized production image
# Works on both Windows Docker Desktop and Linux Docker

FROM node:18-alpine AS base

# Install dependencies needed for native modules
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    && rm -rf /var/cache/apk/*

WORKDIR /app

# Copy package files
COPY package*.json ./

FROM base AS dependencies

# Install all dependencies (including dev dependencies for building)
RUN npm ci

FROM base AS production

# Copy only production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY server.js ./

# Create a non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

# Expose the port (Render will provide PORT via env variable)
EXPOSE 3000

# Set environment to production
ENV NODE_ENV=production
ENV TRANSPORT_MODE=sse

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

# Start the server
CMD ["node", "server.js"]
