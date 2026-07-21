FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# curl for health checks; ca-certificates for HTTPS release download
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

ARG ZS_PROXY_VERSION=0.9.0
# TARGETARCH is set by BuildKit; fall back to uname for classic docker build.
ARG TARGETARCH
RUN set -eux; \
  arch="${TARGETARCH:-}"; \
  if [ -z "$arch" ]; then \
    case "$(uname -m)" in \
      x86_64) arch=amd64 ;; \
      aarch64|arm64) arch=arm64 ;; \
      *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;; \
    esac; \
  fi; \
  case "$arch" in \
    amd64) ZS_ARCH=amd64 ;; \
    arm64) ZS_ARCH=arm64 ;; \
    *) echo "unsupported TARGETARCH=${arch}" >&2; exit 1 ;; \
  esac; \
  curl -fsSL \
    "https://github.com/TxnLab/zs-proxy/releases/download/v${ZS_PROXY_VERSION}/zs-proxy_${ZS_PROXY_VERSION}_linux_${ZS_ARCH}.tar.gz" \
    -o /tmp/zs-proxy.tgz; \
  tar -xzf /tmp/zs-proxy.tgz -C /usr/local/bin zs-proxy; \
  chmod +x /usr/local/bin/zs-proxy; \
  rm /tmp/zs-proxy.tgz; \
  zs-proxy version

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY config/zs-proxy.yaml /app/config/zs-proxy.yaml
COPY docker/entrypoint.sh /app/docker/entrypoint.sh
RUN chmod +x /app/docker/entrypoint.sh \
  && chown -R node:node /app /home/node

USER node
ENV HOME=/home/node
ENV ZEROSIGNAL_KEYRING_BACKEND=file
ENV OPENAI_BASE_URL=http://127.0.0.1:8080/v1
ENV OPEN_AI_API_KEY=zerosignal
EXPOSE 3000
ENTRYPOINT ["/app/docker/entrypoint.sh"]
