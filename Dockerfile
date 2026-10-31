FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
ARG TARBALL_SHA256
ARG LOCKFILE_SHA256
ARG RELEASE_COMMIT
ARG RELEASE_VERSION
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 UNMASK_TARBALL_SHA256=${TARBALL_SHA256}
LABEL org.opencontainers.image.revision=${RELEASE_COMMIT} org.opencontainers.image.version=${RELEASE_VERSION} io.unmask.tarball.sha256=${TARBALL_SHA256} io.unmask.lockfile.sha256=${LOCKFILE_SHA256}
WORKDIR /app
COPY artifact.tgz package.json package-lock.json ./
RUN printf '%s  artifact.tgz\n%s  package-lock.json\n' "$TARBALL_SHA256" "$LOCKFILE_SHA256" | sha256sum -c - \
    && tar -xzf artifact.tgz --strip-components=1 \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && rm artifact.tgz
USER node
EXPOSE 8080
CMD ["node", "dist/server/main.mjs"]
