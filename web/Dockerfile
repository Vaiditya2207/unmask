FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM base AS build
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build -- --webpack

FROM base AS runtime
ARG RELEASE_COMMIT=unknown
ARG RELEASE_VERSION=unknown
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=8080 UNMASK_API_URL=https://unmask-386156642190.asia-south1.run.app RELEASE_COMMIT=${RELEASE_COMMIT} RELEASE_VERSION=${RELEASE_VERSION}
LABEL org.opencontainers.image.revision=${RELEASE_COMMIT} org.opencontainers.image.version=${RELEASE_VERSION}
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 8080
CMD ["node", "server.js"]
