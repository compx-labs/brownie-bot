# Quick start

Get a **dry-run** treasury review working with the minimum config. Signing stays
off; the bot will still spend small amounts of **mainnet USDC** on Canix402
research calls and ZeroSignal inference (via zs-proxy).

For architecture, HTTP API, and signing details, see [README.md](./README.md).

## 1. Prerequisites

- Algorand **mainnet** account for `WALLET_MNEMONIC` that:
  - is opted in to USDC ASA `31566704`
  - holds enough USDC for Canix402 x402 **and** ZeroSignal inference (see
    [Expected costs](#expected-costs))
  - holds enough ALGO for minimum balance, payment fees, and zs-proxy ticket
    reserves
- Either:
  - **Docker / DigitalOcean** (recommended for cloud): Docker build that bundles
    zs-proxy — see [§2a](#2a-digitalocean--docker-recommended-for-cloud), or
  - **Local Node**: Node.js 22+ plus host-installed
    [zs-proxy](https://txnlab.gitbook.io/zerosignal/using-the-proxy/quick-start.md)
    — see [§2b](#2b-local-host-zs-proxy)
- Optional: Telegram bot + chat ID (otherwise reports print to the terminal)
- Optional: DigitalOcean Spaces (otherwise accounting JSON goes under
  `data/accounting/`)

## 2a. DigitalOcean / Docker (recommended for cloud)

The image downloads `zs-proxy`, imports `WALLET_MNEMONIC` on boot (file keyring),
starts the proxy on `127.0.0.1:8080`, then runs Brownie. No host binary needed.

```bash
cp .env.example .env
# set BOT_WALLET, WALLET_MNEMONIC
# add ZEROSIGNAL_KEYSTORE_PASSPHRASE (encrypts the in-container wallet file)

docker build -t brownie-bot .
docker run --env-file .env \
  -e ZEROSIGNAL_KEYSTORE_PASSPHRASE='long-random-secret' \
  -p 3000:3000 brownie-bot
```

Fund the shared wallet **before** the first review (USDC for inference/Canix,
plus ~1.2 ALGO free for the ZeroSignal prepaid MBR pool). On Docker, the
entrypoint runs `zs-proxy fund` at boot to opt into the escrow app and deposit
that pool from existing ALGO. From a laptop:

```bash
# on a laptop with zs-proxy installed:
printf '%s\n' "$WALLET_MNEMONIC" | zs-proxy wallet import --stdin --yes --force
zs-proxy fund --wait   # or zs-proxy fund if ALGO/USDC already present
zs-proxy status        # MBR pool should show ~1.15 ALGO deposited
```

Spend caps ship in [`config/zs-proxy.yaml`](./config/zs-proxy.yaml). Override on
DO with `PROXY_SPEND_DAILY_CAP_USDC` / `PROXY_SPEND_PER_REQUEST_CAP_USDC`.

Then skip to [§4](#4-sanity-checks) / run a review via the container HTTP API or
logs. For one-shot local Node reviews without Docker, use §2b.

## 2b. Local host zs-proxy

```bash
# macOS: brew install txnlab/tap/zs-proxy
# Linux/Windows: see ZeroSignal proxy quick start

zs-proxy wallet import    # paste WALLET_MNEMONIC (or --stdin / --file)
zs-proxy fund --wait      # deposit address + USDC opt-in
zs-proxy proxy start
curl -s http://127.0.0.1:8080/v1/models | head
```

## 3. Install and configure Brownie (local Node)

```bash
npm install
cp .env.example .env
```

Minimum `.env`:

```dotenv
BOT_WALLET=your_treasury_address
WALLET_MNEMONIC=word1 word2 ... word25
ENABLE_TRANSACTION_SIGNING=false
# Docker also needs:
# ZEROSIGNAL_KEYSTORE_PASSPHRASE=long-random-secret
# Defaults (usually fine to omit):
# OPENAI_BASE_URL=http://127.0.0.1:8080/v1
# OPEN_AI_API_KEY=zerosignal
# OPENAI_MODEL=Qwen/Qwen3-Coder-480B-A35B-Instruct
```

Notes:

- In dry-run, `BOT_WALLET` can differ from the mnemonic account. Canix
  personalizes to `BOT_WALLET`; the mnemonic account pays x402 and ZeroSignal.
- `OPEN_AI_API_KEY` is only a placeholder for the OpenAI SDK; zs-proxy ignores
  it. Admission is the wallet imported into the proxy.
- Leave Telegram and Spaces unset for the lightest setup.

## 4. Sanity checks

```bash
# Local Node: zs-proxy must already be running for reviews
npm run dev
# In another terminal:
curl -s localhost:3000/health
```

Expect `telegramConfigured` / `accountingStorage` to reflect what you set
(`local` when Spaces is omitted).

Cheap portfolio probe (pays the positions fee only; does not need the LLM):

```bash
npm run canix:wallet-scan
```

LLM connectivity smoke (ZeroSignal via zs-proxy + one paid
`canix_list_opportunities` call; **no** quotes, swaps, or signing):

```bash
# Local Node: zs-proxy must already be running
npm run smoke:llm

# Docker (starts zs-proxy in-image, then smoke):
docker run --rm --env-file .ENV brownie-bot smoke
```

## 5. First dry-run review

```bash
npm run run-once
```

You should get a plan report on Telegram or in the terminal. With signing
disabled, the bot does **not** call execution-quote, swap, or opt-in endpoints.

Daily service (optional):

```dotenv
RUN_CRON=true
CRON_SCHEDULE=0 9 * * *
CRON_TIMEZONE=UTC
```

```bash
npm run dev
```

## 6. Enable signing later

Only after several clean dry runs:

1. Confirm `BOT_WALLET` is the address derived from `WALLET_MNEMONIC`
2. Review policy knobs in `.env.example`
3. Set `ENABLE_TRANSACTION_SIGNING=true`

Signing adds execution-quote payments (~0.10 USDC ceiling per quote request)
plus on-chain ALGO fees for submitted groups.

---

## Expected costs

Amounts below for Canix are **bot payment ceilings** (maximum the bot will sign
for that endpoint). Live Canix402 prices are at or below these. USDC has
**6 decimals**: `1_000_000` base units = **1 USDC**.

The same wallet also pays ZeroSignal per message through zs-proxy — set proxy
`spend` caps separately from Brownie's `MAX_DAILY_X402_BASE_UNITS`.

### Canix402 x402 ceilings

| Endpoint / tool | Ceiling (base units) | Ceiling (USDC) | Typical use |
| --- | ---: | ---: | --- |
| Positions (`canix_get_positions`) | 5,000 | 0.005 | Every review + wallet scan |
| List opportunities | 10,000 | 0.01 | Research |
| Search / filter opportunities | 10,000 | 0.01 | Research (high-TVL discovery) |
| Protocol opportunities | 10,000 | 0.01 | Per protocol query |
| Personalized opportunities | 50,000 | 0.05 | Every review (usually) |
| Swap transactions | 5,000 | 0.005 | **Signing only** |
| Execution quotes | 100,000 | 0.10 | **Signing only** (flat per quote request) |

Free (no x402 payment path): `canix_health`, `canix_get_token_prices` (used by
accounting).

### Ballpark per dry-run review

**`AI_MODE=full` (default):** a typical dry-run pays for **positions + personalized + a few list/search/protocol
calls**, plus **ZeroSignal** usage for the multi-turn planning model loop. Recent Canix
x402 spend often lands around **~0.05–0.15 USDC**, depending on how many research
tools the model calls (`AI_MAX_TOOL_CALLS`, default 16). Inference cost depends
on the live ZeroSignal catalog price for `OPENAI_MODEL` (default
`Qwen/Qwen3-Coder-480B-A35B-Instruct`) and how many tool-follow-up turns run;
see [ZeroSignal pricing](https://txnlab.gitbook.io/zerosignal/for-users/pricing.md).

**`AI_MODE=lite`:** the host prefetches research (personalized + list; no
protocol favoritism), then makes **one**
decide-only ZeroSignal call with tools disabled. Canix x402 is similar; ZeroSignal spend
is usually much lower because there is no multi-turn tool loop. Prefer
`OPENAI_REASONING_EFFORT=high` in lite so the single decide turn stays high quality.

CLI one-shots (each spends real USDC; no LLM):

| Command | Approx. cost |
| --- | --- |
| `npm run canix:wallet-scan` | ~0.005 USDC (positions) |
| `npm run canix:opportunities` | ≤ 0.01 USDC |
| `npm run canix:personalized` | ≤ 0.05 USDC |

### Other costs

| Cost | Notes |
| --- | --- |
| **ALGO fees** | Tiny network fees for each x402 payment txn; zs-proxy prepaid ticket pool (~ALGO); larger when signing/submitting portfolio txs |
| **ZeroSignal** | Pay-per-message from the shared mnemonic via zs-proxy; use proxy `daily_cap_usdc` / `per_request_cap_usdc` |
| **Daily Canix x402 cap** | Default `MAX_DAILY_X402_BASE_UNITS=5000000` (5 USDC/day); raise if needed |
| **Telegram / Spaces** | Optional; Spaces only if you configure it |

Canix ceilings and the Canix API origin are **code invariants** in
`src/integrations/canix402/payment.ts`, not `.env` knobs.
