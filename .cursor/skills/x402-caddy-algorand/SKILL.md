---
name: x402-caddy-algorand
description: Implement or review x402-gated APIs using Caddy edge enforcement, Algorand USDC payments, and OpenAPI/agent discoverability. Use when configuring Caddy x402 gateways, adding paid API routes, creating PAYMENT-SIGNATURE payloads with algosdk, aligning discovery/OpenAPI metadata, setting up OpenAI-compatible action/tool schemas, or testing x402 verify/settle flows.
---

# x402 Caddy Algorand

Use this skill when a project needs x402-paid HTTP endpoints with Caddy at the edge and Algorand payment payloads from clients.

## When To Use

Trigger on requests like:

- "configure Caddy x402"
- "add paid endpoint"
- "PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE"
- "algosdk payment payload"
- "facilitator verify settle"
- "OpenAPI discovery for paid routes"
- "OpenAI actions/tools setup for x402 API"

## Core Architecture Rule

Default split of responsibilities:

1. Caddy gateway enforces payment at the edge.
2. Facilitator verifies and settles payment payloads.
3. API app exposes route policy, discovery metadata, and business responses.
4. Wallet keys stay client-side; never store payer mnemonic/private key on API or Caddy.

If this split is broken, fix architecture before tuning route logic.

## Implementation Checklist

Copy this checklist and track progress:

```text
Task Progress:
- [ ] Define paid/free route policy in app code
- [ ] Publish discovery/OpenAPI x402 metadata from env
- [ ] Configure Caddy x402 before reverse_proxy
- [ ] Gate paid paths with Caddy matchers + handle blocks
- [ ] Align Caddy env and API env (network, asset, payTo, amount)
- [ ] Verify headers and preflight flow
```

### 1) App policy and metadata

- Keep one source of truth for endpoint access (`free` vs `paid`).
- Build discovery output from that policy source.
- For paid operations include x402 metadata:
  - protocol version
  - facilitator URL
  - requirement template (scheme/network/asset/payTo/maxAmountRequired)
  - expected payment headers
- Keep free discovery endpoints reachable without payment (usually `/discovery`, `/openapi.json`, optional `/metadata`).

### 2) Caddy edge gating

- Set ordering once in the global Caddy block:

```caddyfile
{
    order x402 before reverse_proxy
}
```

- Route design:
  - free matcher -> direct reverse proxy
  - paid matcher -> `x402 { ... }` then reverse proxy
  - fallback -> 404 or default handler

- Inside each `x402` block include at least one `accept` policy:
  - `pay_to`
  - `price`
  - `network`
  - `scheme` (usually `exact`)

- Keep values env-driven (`{$VAR}`) to support local, staging, and production.

### 3) Env alignment rules

Keep these aligned between Caddy config and API metadata:

- network identifier (`X402_NETWORK` and API-facing network field)
- USDC asset id
- payTo receiver address
- amount/price semantics
- facilitator URL

If these drift, discovery can advertise requirements that Caddy/facilitator rejects.

## Discoverability and OpenAI Setup

### Discovery contract

- Ensure `/openapi.json` and `/discovery` are available through the gateway, not just upstream.
- Mark paid operations with:
  - `402` response in OpenAPI
  - `x-x402` extension (or project x402 extension convention)
  - clear header requirements (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`)
- Use operation descriptions that are agent-readable:
  - what is paid
  - expected network/asset
  - preflight -> pay -> retry behavior

### OpenAI-compatible action/tool schemas

- Use the public Caddy gateway URL as server/base URL.
- Include free discovery endpoints so clients can inspect capabilities before calling paid routes.
- Describe x402 retry flow in endpoint descriptions and error docs:
  - initial call may return `402` with `PAYMENT-REQUIRED`
  - client signs and retries with `PAYMENT-SIGNATURE`
  - success may include `PAYMENT-RESPONSE`
- Do not encode payer secrets or wallet seed material in OpenAPI schemas.
- Keep auth and payment concerns separate in docs (e.g., API key auth plus x402 payment if both apply).

### Discoverability smoke checks

Run checks against the gateway URL:

1. fetch `/openapi.json` and verify paid operations are marked paid
2. fetch `/discovery` and verify paid/free route classifications match
3. call a paid route without signature and expect `402` + `PAYMENT-REQUIRED`

## Algorand Payment Payload (Client Side)

Use client or test code to build payment payloads.

### Required pattern

1. Build USDC ASA transfer with `algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject`.
2. Use micro-USDC amount.
3. Sign transaction with client account key.
4. Base64 encode signed txn blob(s) into `paymentGroup`.
5. Set `paymentIndex` to the paying transaction index.
6. Wrap into base64 JSON for `PAYMENT-SIGNATURE`.

Example shape:

```typescript
const payload = {
  x402Version: 2,
  scheme: "exact",
  network: "algorand-mainnet",
  accepted: {/* selected accept option */},
  payload: {
    paymentGroup: ["<base64-signed-or-unsigned-group-members>"],
    paymentIndex: 0,
  },
  paymentRequired: {/* decoded PAYMENT-REQUIRED */},
};
```

### Fee-payer variant

Only use fee-payer/atomic-group variants when facilitator output explicitly includes that requirement (for example, via `accepted.extra` fields such as `feePayer`).

## Verification Workflow

Use this order:

1. Build Caddy binary with x402 plugin.
2. Start API and Caddy gateway.
3. Smoke test free route (`200`) and paid route preflight (`402`).
4. Run fast policy/discovery/OpenAPI consistency tests.
5. Run Caddy E2E with facilitator mock.
6. Run live paid tests only when spend-enabled env is intentionally configured.

## Troubleshooting

- Paid endpoint returns `200` without payment:
  - Caddy paid matcher likely missed route, or middleware order is wrong.
- Discovery says route is paid but gateway does not enforce:
  - policy matrix and Caddy matchers are out of sync.
- OpenAI/action client sees API but misses paid behavior:
  - server URL points to upstream API instead of Caddy, or OpenAPI lacks `402`/x402 metadata.
- Caddy starts with unknown `x402` directive:
  - binary was not built with the x402 plugin.
- Facilitator rejects signed payment:
  - mismatch in network, asset id, payTo, amount, expiry, or payment group/index.
- Live Algorand test fails before verification:
  - account missing ALGO fees, USDC balance, asset opt-in, or required mnemonic env.

## Guardrails

- Keep examples non-secret: placeholders only, never real mnemonics.
- Prefer one canonical term set in docs:
  - Caddy gateway
  - facilitator
  - payment policy
  - `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`
- Keep this skill reusable across projects; avoid product-specific naming except in optional examples.
