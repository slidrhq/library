# syntax=docker/dockerfile:1.7
# A local library (docs/SPEC.md §5.4): Nginx at the door of the library's server on Node, as one
# image for Linux, run by the install script's compose.yaml (docs/PLAN.md P11, P12). Built from the
# repository's root: docker build -f docker/Dockerfile .

# The Node that CI tests with, its official slim image of Debian 13, pinned by digest.
ARG NODE=node:22-trixie-slim@sha256:8eb619e402eaede1748a3c8173bffab391592812e85136452f781741c7242ddf

# The page and the server are JavaScript, the same for every architecture: built once, natively.
FROM --platform=$BUILDPLATFORM ${NODE} AS build
WORKDIR /src
COPY . .
# The pnpm that package.json names (packageManager), as CI uses it.
RUN npm install --global "$(node -p "require('./package.json').packageManager")" \
 && pnpm install --frozen-lockfile \
 && pnpm build

FROM ${NODE}
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Slidr Library" \
      org.opencontainers.image.description="A local Slidr media library: its page, its API and its media, behind Nginx" \
      org.opencontainers.image.source="https://github.com/slidrhq/library" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
RUN apt-get update \
 && apt-get install -y --no-install-recommends nginx tini \
 && rm -rf /var/lib/apt/lists/* /etc/nginx/sites-enabled /etc/nginx/conf.d \
 && groupadd --gid 10001 slidr \
 && useradd --uid 10001 --gid slidr --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin slidr \
 && mkdir -p /library/data /library/media /library/keys /library/tls \
 && chown -R 10001:10001 /library
COPY --from=build /src/dist/client /app/dist/client
COPY --from=build /src/dist/node/library.mjs /src/dist/node/library.mjs.map /app/dist/node/
COPY docker/nginx.conf docker/library.conf docker/media.conf docker/media-methods.conf docker/media-headers.conf docker/media-types.conf /etc/nginx/slidr/
COPY docker/health.mjs /app/health.mjs
COPY --chmod=0755 docker/entry.sh /usr/local/bin/slidr-library-entry
COPY --chmod=0755 docker/slidr-library.sh /usr/local/bin/slidr-library
# The command of the machine, which the install script copies out (install/slidr-library).
COPY --chmod=0755 install/slidr-library /app/host/slidr-library
ENV NODE_ENV=production \
    SLIDR_LIBRARY_DATA=/library/data \
    LIBRARY_CLIENT=/app/dist/client/
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node", "/app/health.mjs"]
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/slidr-library-entry"]
CMD ["serve"]
