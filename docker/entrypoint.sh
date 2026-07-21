#!/usr/bin/env bash
# Start host-local zs-proxy in-process, then Brownie. Used by the Docker image
# on DigitalOcean (and any single-container host) where a separate host binary
# is not available.
set -euo pipefail

PROXY_BIN="${ZS_PROXY_BIN:-/usr/local/bin/zs-proxy}"
PROXY_CONFIG="${ZS_PROXY_CONFIG:-/app/config/zs-proxy.yaml}"
PROXY_URL="${OPENAI_BASE_URL:-http://127.0.0.1:8080/v1}"
PROXY_HEALTH="${PROXY_HEALTH_URL:-http://127.0.0.1:8080/healthz}"

if [[ ! -x "$PROXY_BIN" ]]; then
  echo "zs-proxy binary not found at $PROXY_BIN" >&2
  exit 1
fi

if [[ -z "${WALLET_MNEMONIC:-}" ]]; then
  echo "WALLET_MNEMONIC is required (shared Canix + ZeroSignal payer)" >&2
  exit 1
fi

# Containers have no OS keychain — use the encrypted-file backend.
export ZEROSIGNAL_KEYRING_BACKEND="${ZEROSIGNAL_KEYRING_BACKEND:-file}"
if [[ -z "${ZEROSIGNAL_KEYSTORE_PASSPHRASE:-}" ]]; then
  echo "ZEROSIGNAL_KEYSTORE_PASSPHRASE is required when ZEROSIGNAL_KEYRING_BACKEND=file" >&2
  exit 1
fi

# Ensure a writable home for zs-proxy state (wallet.json, spend counters).
export HOME="${HOME:-/home/node}"
mkdir -p "$HOME/.config/zerosignal"

echo "Importing shared wallet into zs-proxy (file keyring)..."
printf '%s\n' "$WALLET_MNEMONIC" | "$PROXY_BIN" wallet import \
  --stdin \
  --yes \
  --force \
  --network mainnet

# Opt into the ZeroSignal escrow app and fund the prepaid ticket-MBR pool
# (~1.15 ALGO for 10 slots). Without this, reserves fail with payer_not_opted_in
# (often misreported as operators_busy / 503).
echo "Ensuring ZeroSignal prepaid MBR pool (zs-proxy fund)..."
"$PROXY_BIN" fund --network mainnet

echo "Starting zs-proxy (foreground child)..."
"$PROXY_BIN" proxy start --foreground --config "$PROXY_CONFIG" --network mainnet &
PROXY_PID=$!

cleanup() {
  if kill -0 "$PROXY_PID" 2>/dev/null; then
    kill "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "Waiting for zs-proxy at $PROXY_HEALTH ..."
for _ in $(seq 1 60); do
  if curl -sf "$PROXY_HEALTH" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$PROXY_PID" 2>/dev/null; then
    echo "zs-proxy exited before becoming healthy" >&2
    wait "$PROXY_PID" || true
    exit 1
  fi
  sleep 0.5
done

if ! curl -sf "$PROXY_HEALTH" >/dev/null 2>&1; then
  echo "zs-proxy did not become healthy in time" >&2
  exit 1
fi

echo "zs-proxy ready; OPENAI_BASE_URL=${PROXY_URL}"
export OPENAI_BASE_URL="$PROXY_URL"
export OPEN_AI_API_KEY="${OPEN_AI_API_KEY:-zerosignal}"

mode="${1:-}"
if [[ "$mode" == "smoke" || "$mode" == "llm-smoke" || "${RUN_LLM_SMOKE:-}" == "true" ]]; then
  echo "Running ZeroSignal+Canix LLM smoke (dist/smoke-llm.js)..."
  echo "This path never quotes swaps or signs treasury txs."
  node dist/smoke-llm.js
  status=$?
elif [[ "$mode" == "once" || "${RUN_ONCE:-}" == "true" ]]; then
  echo "Running one-shot treasury review (dist/run-once.js)..."
  node dist/run-once.js
  status=$?
else
  # Keep this shell as PID 1 so the trap can stop zs-proxy on SIGTERM (DO/K8s).
  node dist/index.js
  status=$?
fi

cleanup
trap - EXIT INT TERM
exit "$status"
