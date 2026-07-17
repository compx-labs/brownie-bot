# Quick start

Get a **dry-run** treasury review working with the minimum config. Signing stays
off; the bot will still spend small amounts of **mainnet USDC** on Canix402
research calls.

For architecture, HTTP API, and signing details, see [README.md](./README.md).

## 1. Prerequisites

- **Node.js 22+** (`nvm use` if you use `.nvmrc`)
- Algorand **mainnet** account for `WALLET_MNEMONIC` that:
  - is opted in to USDC ASA `31566704`
  - holds enough USDC for x402 calls (see [Expected costs](#expected-costs))
  - holds enough ALGO for minimum balance and payment fees
- **OpenAI API key**
- Optional: Telegram bot + chat ID (otherwise reports print to the terminal)
- Optional: DigitalOcean Spaces (otherwise accounting JSON goes under
  `data/accounting/`)

## 2. Install and configure

```bash
npm install
cp .env.example .env
```

Minimum `.env`:

```dotenv
BOT_WALLET=your_treasury_address
WALLET_MNEMONIC=word1 word2 ... word25
OPEN_AI_API_KEY=sk-...
ENABLE_TRANSACTION_SIGNING=false
```

Notes:

- In dry-run, `BOT_WALLET` can differ from the mnemonic account. Canix
  personalizes to `BOT_WALLET`; the mnemonic account pays x402.
- Leave Telegram and Spaces unset for the lightest setup.

## 3. Sanity checks

```bash
# Config + optional integrations
npm run dev
# In another terminal:
curl -s localhost:3000/health
```

Expect `telegramConfigured` / `accountingStorage` to reflect what you set
(`local` when Spaces is omitted).

Cheap portfolio probe (pays the positions fee only):

```bash
npm run canix:wallet-scan
```

## 4. First dry-run review

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

## 5. Enable signing later

Only after several clean dry runs:

1. Confirm `BOT_WALLET` is the address derived from `WALLET_MNEMONIC`
2. Review policy knobs in `.env.example`
3. Set `ENABLE_TRANSACTION_SIGNING=true`

Signing adds execution-quote payments (~0.10 USDC ceiling per quote request)
plus on-chain ALGO fees for submitted groups.

---

## Expected costs

Amounts below are **bot payment ceilings** (maximum the bot will sign for that
endpoint). Live Canix402 prices are at or below these. USDC has **6 decimals**:
`1_000_000` base units = **1 USDC**.

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

A typical dry-run pays for **positions + personalized + a few list/search/protocol
calls**. Recent runs often land around **~0.05–0.15 USDC** total x402 spend,
depending on how many research tools the model calls (`AI_MAX_TOOL_CALLS`,
default 16).

CLI one-shots (each spends real USDC):

| Command | Approx. cost |
| --- | --- |
| `npm run canix:wallet-scan` | ~0.005 USDC (positions) |
| `npm run canix:opportunities` | ≤ 0.01 USDC |
| `npm run canix:personalized` | ≤ 0.05 USDC |

### Other costs

| Cost | Notes |
| --- | --- |
| **ALGO fees** | Tiny network fees for each x402 payment txn; larger when signing/submitting portfolio txs |
| **OpenAI** | Usage-based on your model (`OPENAI_MODEL`); not capped by this repo |
| **Daily x402 cap** | Default `MAX_DAILY_X402_BASE_UNITS=5000000` (5 USDC/day); raise if needed |
| **Telegram / Spaces** | Optional; Spaces only if you configure it |

Ceilings and the Canix API origin are **code invariants** in
`src/integrations/canix402/payment.ts`, not `.env` knobs.
