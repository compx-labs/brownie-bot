# Brownie Bot

An autonomous community treasury backend for Algorand. Once per day it reads
liquid balances and Canix402 DeFi positions, researches personalized and global
opportunities, asks OpenAI for a diversified portfolio plan, validates that plan
against deterministic limits, and obtains unsigned execution groups.

Transaction signing is disabled by default. In dry-run mode the bot decodes and
validates groups but never signs or submits them. When explicitly enabled, it
signs approved transactions locally and submits unchanged atomic groups through
its own Algod client. Canix402 never receives the mnemonic.

## Requirements

- Node.js 20 or newer
- An Algorand mainnet wallet with:
  - enough ALGO to meet minimum-balance requirements
  - an opt-in to mainnet USDC ASA `31566704`
  - enough USDC for Canix402 calls (the personalized endpoint currently costs
    50,000 base units, or 0.05 USDC)
- A Telegram bot token and destination chat ID for reporting
- An OpenAI API key for opportunity recommendations

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Configure the treasury address used for personalization and the separate funded
account that pays x402 access fees:

```dotenv
BOT_WALLET="58-character Algorand address"
WALLET_MNEMONIC="word1 word2 ... word25"
```

In dry-run mode, `BOT_WALLET` does not need to match the account derived from
`WALLET_MNEMONIC`: Canix402 personalizes results to `BOT_WALLET`, while the
mnemonic account funds x402 payments. Enabling transaction signing requires
them to match because the same local key then authorizes treasury actions. The
mnemonic is never sent to MCP, Telegram, logs, or API responses.

Configure OpenAI separately:

```dotenv
OPEN_AI_API_KEY=
OPENAI_MODEL="gpt-5.6-luna"
OPENAI_REASONING_EFFORT="medium"
AI_MAX_TOOL_CALLS=16
ENABLE_TRANSACTION_SIGNING=false
```

The model receives discovered Canix402 data and quote-generation tools but
cannot access the mnemonic, payment signature, local signing, or Algod
submission. The host injects `BOT_WALLET`, enforces allocation and spend policy,
and fails closed on incomplete portfolio data or malformed transactions.

To enable execution, first confirm `BOT_WALLET` is the account derived from
`WALLET_MNEMONIC`, review the policy variables in `.env.example`, complete
several dry runs, and then set:

```dotenv
ENABLE_TRANSACTION_SIGNING=true
```

Mainnet, USDC ASA `31566704`, the Canix402 API origin, and endpoint payment
ceilings are code-level invariants rather than environment configuration.
Current ceilings are 5,000 base units for positions and swap transaction
generation, 10,000 for general/search/protocol opportunities, 50,000 for
personalized opportunities, and 100,000 for execution quotes. A separate daily
x402 cap applies. The bot validates every live requirement against these limits
before signing. Facilitator fee-payer groups are supported.

## Canix402 CLI tests

These commands make real mainnet USDC payments from `WALLET_MNEMONIC`. The
optional positional argument is the result limit and defaults to `10`.

General ranked opportunities (0.01 USDC):

```bash
npm run canix:opportunities
npm run canix:opportunities -- 25
```

Personalized recommendations for `BOT_WALLET` (0.05 USDC):

```bash
npm run canix:personalized
npm run canix:personalized -- 25
```

Each command prints the x402 payer, the personalization target when applicable,
payment receipt details, and a ranked table containing protocol, type, assets,
APY/APR, TVL, and source timestamp. No mnemonic or payment signature is printed.

## Running reviews

Run the HTTP service without an internal schedule:

```bash
npm run dev
```

Enable the daily in-process scheduler:

```dotenv
RUN_CRON=true
CRON_SCHEDULE="0 9 * * *"
CRON_TIMEZONE="UTC"
```

For a platform scheduler, Kubernetes CronJob, or system cron, prefer the
one-shot process:

```bash
npm run run-once
```

Every review reconstructs its planning state from current on-chain liquid
balances and the Canix402 positions endpoint. Accounting history is always
stored in DigitalOcean Spaces. The in-process latest-run response is operational
convenience only and is lost on restart. The scheduler and overlap lock assume a
single service replica.

## Accounting snapshots

Accounting is always enabled. Configure DigitalOcean Spaces and the daily
schedule:

```dotenv
ACCOUNTING_CRON_SCHEDULE="0 8 * * *"
ACCOUNTING_CRON_TIMEZONE="UTC"
DO_SPACES_ENDPOINT="https://nyc3.digitaloceanspaces.com"
DO_SPACES_REGION="nyc3"
DO_SPACES_BUCKET="your-bucket"
DO_SPACES_KEY=
DO_SPACES_SECRET=
DO_SPACES_PREFIX="brownie-bot"
```

Accounting uses free MCP tool `canix_get_token_prices` (`POST /pricing`) for
wallet token USD prices (including ALGO) and Canix position valuations for DeFi
holdings.
It never signs portfolio transactions. The currently paid `canix_get_positions`
call remains a budgeted dependency for portfolio reads. The accounting cron
starts with the HTTP process; the AI review cron remains behind `RUN_CRON`.

One-shot accounting for platform schedulers:

```bash
npm run accounting-once
```

Each run stores a snapshot, compares totals to the previous summary when one
exists, and reports DeFi value by protocol, wallet token total (including ALGO
USD), ALGO balance in token units, and account minimum balance. Missing prices,
empty DeFi books, and a missing prior baseline are reported as notes — they do
not fail the run. Optional external cashflows can still be recorded through
`POST /accounting/cashflows`.

## HTTP API

- `GET /health` — configuration readiness without contacting or spending
  through Canix402
- `GET /runs/latest` — latest in-memory review result
- `POST /runs` — manually run a review; disabled unless
  `MANUAL_TRIGGER_TOKEN` is set and requires
  `Authorization: Bearer <token>`
- `GET /accounting/latest` — latest accounting run
- `POST /accounting/run` — manually run accounting; same bearer token model
- `POST /accounting/cashflows` — record an immutable external cashflow event

## Canix402 payment flow

The integration uses Streamable HTTP MCP at
`https://canix402-mcp.compx.io/mcp`:

1. Call `canix_get_personalized_opportunities` without a payment signature.
2. Validate the returned live `PAYMENT_REQUIRED` details.
3. Build and sign the exact Algorand USDC payment locally.
4. Retry the same MCP call with only `paymentSignature` added.
5. Provide positions and opportunities to the portfolio agent.
6. Request fresh unsigned execution/swap groups for approved actions.
7. Decode every transaction and enforce the managed sender, declared spend,
   fee cap, mainnet genesis hash, validity window, atomic group, signer metadata,
   and no rekey/close/clawback rules.
8. Sign locally and submit only when the signing gate is enabled.

Free tools such as `canix_health` and `canix_get_token_prices` skip the payment
retry path entirely.

There is deliberately no direct-HTTP fallback. MCP errors fail the review and
are reported to Telegram. During initial scaffolding on July 13, 2026, the
remote paid MCP preflight and health tool returned an `INTERNAL_ERROR` while
the MCP tool catalog and direct API preflight remained reachable; the service
surfaces this condition without bypassing MCP.

The bot verifies required tool names and critical input-schema fields before
making a paid positions call. As of July 14, 2026, the live MCP execution-quote
input schema exposes only the common asset-A/asset-B fields even though its
shape catalog includes protocol-specific actions. Unsupported shapes therefore
fail closed rather than falling back to direct REST or signing an unvalidated
request.

## Telegram

Set both variables:

```dotenv
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

Review reports include the portfolio plan, expected net benefit, policy blocks,
signing mode, action outcomes, transaction IDs, x402 totals, and failures.
Accounting reports include DeFi value by protocol, wallet token total (including
ALGO USD), ALGO and minimum balance in token units, P&L versus the previous
snapshot when available, unpriced assets, and the Spaces snapshot key. Telegram
delivery errors are stored without replacing the underlying result.

## Verification

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
```

The normal suite mocks all paid behavior and never spends funds. The opt-in live
smoke test calls only the free Canix402 health tool:

```bash
RUN_LIVE_SMOKE=true npm run test:smoke
```

Paid end-to-end testing must be performed deliberately with the configured,
funded wallet.

## Container

```bash
docker build -t brownie-bot .
docker run --env-file .env -p 3000:3000 brownie-bot
```
