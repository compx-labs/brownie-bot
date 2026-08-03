---
name: use-zs-proxy
description: >-
  Integrate ZeroSignal inference through zs-proxy with the OpenAI Responses API:
  wallet seal admission, privacy/no-relay config, store:false, client-side
  conversation replay (never previous_response_id), and X-Zs-* cost headers.
  Use when wiring zs-proxy, ZeroSignal LLM calls, /v1/responses multi-turn
  loops, OPENAI_BASE_URL to a local proxy, or fixing relay 504s / response_id
  issues.
---

# Use zs-proxy (ZeroSignal)

Use zs-proxy as an OpenAI-compatible local gateway. Admission is the on-chain
wallet seal — not an API key. Multi-turn agents must keep history **client-side**.

## Hard rules (do not violate)

1. **`store: false` on every `responses.create`** — ZeroSignal nodes do not keep
   prompt history the way OpenAI hosted storage does.
2. **Never send `previous_response_id`** — even if the response has an `id`.
   Replays that chain on server-side ids fail or are unreliable on ZS.
3. **Replay the transcript yourself** — each follow-up `input` is the original
   user message plus accumulated `output` items and `function_call_output`s.
4. **Prefer no privacy relay for multi-turn** — `zs.privacy: false` (direct to
   the model operator). Relays through `*.belt.algo.xyz` commonly cause CDN
   502/504s on multi-turn `/v1/responses`.
5. **`stream: true` on every `responses.create`** — without streaming, any hop
   in the proxy/operator chain can hard-timeout while waiting for a silent
   full-body response. Consume the SSE stream to `response.completed` (see
   `finalResponseFromStream`) before treating the call as done.

## Proxy config

Minimal proxy settings used in this project:

```yaml
algod:
  network: "mainnet"

server:
  listen: "127.0.0.1:8080"

# Direct to the model operator (no privacy relay hop).
# Tradeoff: the target operator sees this client's IP.
# Re-enable relays with privacy: true or PROXY_ZS_PRIVACY=true.
zs:
  privacy: false
  allow_privacy_override: true

spend:
  daily_cap_usdc: 5.00
  per_request_cap_usdc: 1.00
```

Env overrides (Docker/proxy): `PROXY_ZS_PRIVACY`, `PROXY_SPEND_DAILY_CAP_USDC`,
`PROXY_SPEND_PER_REQUEST_CAP_USDC`.

## Client setup

```ts
import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:8080/v1",
  // Placeholder only — zs-proxy ignores the key; wallet seal admits requests.
  apiKey: process.env.OPEN_AI_API_KEY ?? "zerosignal",
});
```

Before calling inference:

1. Import the payer mnemonic into zs-proxy (`zs-proxy wallet import`).
2. Fund the prepaid ticket / MBR pool (`zs-proxy fund` / `fund --wait`).
3. Start the proxy (`zs-proxy proxy start`) and confirm `/healthz` and
   `GET /v1/models`.

Containers: use the file keyring
(`ZEROSIGNAL_KEYRING_BACKEND=file` + `ZEROSIGNAL_KEYSTORE_PASSPHRASE`). Unset
extra `*_MNEMONIC` env vars before start so the proxy does not require an
ambiguous payer; set `PROXY_ZS_PROXY_PAYER_ADDR` when needed.

## Multi-turn Responses loop (canonical pattern)

```ts
const initialInput = "..."; // string or structured JSON string
let conversationItems: unknown[] = [];

let response = await openai.responses.create({
  model,
  instructions,
  input: initialInput,
  store: false, // required
  stream: true, // required — avoid silent read timeouts
  tools,
  tool_choice: "auto",
  // do NOT pass previous_response_id
});
// When using the OpenAI SDK directly, drain SSE to response.completed
// (this repo uses finalResponseFromStream / createPortfolioAgent).

while (hasFunctionCalls(response.output)) {
  const outputs = await runTools(response.output); // function_call_output[]
  conversationItems = [...conversationItems, ...response.output, ...outputs];

  response = await openai.responses.create({
    model,
    instructions,
    input: [
      { role: "user", content: initialInput },
      ...conversationItems,
    ],
    store: false, // required every turn
    stream: true, // required every turn
    tools,
    tool_choice: "auto",
    // still no previous_response_id
  });
}
```

Notes:

- Treat empty or missing `response.id` as normal; never branch on it for
  continuation.
- Repair / follow-up turns use the same replay pattern (append another user
  message to `input`, still `store: false`).
- Prefer returning `{ data, headers }` from the create call when you need costs
  (OpenAI SDK with `response` metadata, or a thin wrapper).

## Inference cost headers

zs-proxy settles per request and exposes amounts on response headers:

- Primary: `X-Zs-Inference-Amount` (USDC decimal string)
- Collect any `X-Zs-*` headers for debugging / breakdown

Sum charges across turns for a run total. Missing headers → skip that turn
rather than inventing a price.

## Checklist for new zs-proxy agents

- [ ] `OPENAI_BASE_URL` points at zs-proxy `/v1` (default `http://127.0.0.1:8080/v1`)
- [ ] Proxy wallet funded; `/healthz` healthy before first review
- [ ] `zs.privacy: false` unless the user explicitly wants relay privacy
- [ ] Every `responses.create` sets `store: false`
- [ ] Every `responses.create` sets `stream: true` and drains to `response.completed`
- [ ] No `previous_response_id` anywhere in the agent loop
- [ ] Follow-ups rebuild `input` from client-side transcript
- [ ] Tests assert `store: false`, `stream: true`, and absent `previous_response_id` on first and
      follow-up calls
- [ ] Optional: parse `X-Zs-Inference-Amount` from headers

## Anti-patterns

| Don't | Do instead |
| --- | --- |
| `store: true` or omit `store` expecting OpenAI persistence | Always `store: false` |
| Non-streaming `/v1/responses` (omit `stream` or `stream: false`) | Always `stream: true`; consume SSE to completed |
| `previous_response_id: response.id` | Append prior `output` + tool outputs to `input` |
| Default `zs.privacy: true` for long tool loops | `privacy: false`; document IP tradeoff |
| Treat `OPEN_AI_API_KEY` as a real secret for ZS | Placeholder string; seal is the wallet |
| Assume response `id` is required for the next turn | Ids may be empty; ignore for chaining |
| Route multi-turn traffic through flaky relays without a reason | Direct operator path; re-enable privacy only when needed |

## Reference in this repo

- Proxy defaults: `config/zs-proxy.yaml`
- Agent loop: `src/services/portfolio-agent.ts` (`createAgentResponse`,
  `withStreamTrue`, `finalResponseFromStream`, conversation replay)
- Smoke loop: `src/smoke-llm.ts`
- Cost parsing: `src/services/inference-cost.ts`
- Container boot: `docker/entrypoint.sh`
- Tests: `tests/portfolio-agent.test.ts` (“never sends previous_response_id”)
