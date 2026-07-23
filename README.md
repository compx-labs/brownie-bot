# Brownie Bot

[![CI](https://github.com/compx-labs/brownie-bot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/compx-labs/brownie-bot/actions/workflows/ci.yml)

An autonomous community treasury backend for Algorand. Once per day it reads
liquid balances and Canix402 DeFi positions, researches personalized and global
opportunities, asks a ZeroSignal model (via zs-proxy) for a diversified
portfolio plan, validates that plan against deterministic limits, and — when
signing is enabled — obtains unsigned execution groups for local signing.

Transaction signing is disabled by default. In dry-run mode the bot reports the
validated plan and does not call execution quote, swap, or opt-in endpoints.
When explicitly enabled, it fetches transaction groups, signs approved
transactions locally, and submits unchanged atomic groups through its own Algod
client. Canix402 never receives the mnemonic.

**New here?** Start with **[QUICKSTART.md](./QUICKSTART.md)** (minimum setup +
expected Canix402 / ZeroSignal costs), then return to this README for full
configuration and ops detail. Want to change the code? See
**[CONTRIBUTING.md](./CONTRIBUTING.md)**.

## Requirements

- Node.js 22 or newer
- An Algorand mainnet wallet with USDC ASA `31566704` opt-in and enough USDC/ALGO
  for Canix402 x402 and ZeroSignal (see
  [QUICKSTART.md — Expected costs](./QUICKSTART.md#expected-costs))
- ZeroSignal via zs-proxy using the same mnemonic (Docker image bundles the
  binary; local Node needs a host install — see
  [QUICKSTART.md](./QUICKSTART.md))
- Optional: Telegram (otherwise reports print to the terminal)
- Optional: DigitalOcean Spaces (otherwise accounting JSON under
  `data/accounting/`)

## Quick start

See **[QUICKSTART.md](./QUICKSTART.md)** for the dry-run checklist and cost
table. Short version (DigitalOcean / Docker):

```bash
cp .env.example .env
# set BOT_WALLET, WALLET_MNEMONIC, ZEROSIGNAL_KEYSTORE_PASSPHRASE
# fund the wallet on-chain once (see QUICKSTART)
docker build -t brownie-bot .
docker run --env-file .env -p 3000:3000 brownie-bot
```

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Configure the treasury address used for personalization and the funded account
that pays Canix402 x402 (import the same mnemonic into zs-proxy for inference):

```dotenv
BOT_WALLET="58-character Algorand address"
WALLET_MNEMONIC="word1 word2 ... word25"
```

In dry-run mode, `BOT_WALLET` does not need to match the account derived from
`WALLET_MNEMONIC`: Canix402 personalizes results to `BOT_WALLET`, while the
mnemonic account funds x402 and ZeroSignal. Enabling transaction signing requires
them to match because the same local key then authorizes treasury actions. The
mnemonic is never sent to MCP, Telegram, logs, or API responses.

Configure the OpenAI-compatible ZeroSignal proxy (defaults target host-local
zs-proxy):

```dotenv
OPENAI_BASE_URL="http://127.0.0.1:8080/v1"
OPEN_AI_API_KEY="zerosignal"
OPENAI_MODEL="Qwen/Qwen3-Coder-480B-A35B-Instruct"
OPENAI_REASONING_EFFORT="medium"
AI_MODE=full
AI_MAX_TOOL_CALLS=16
ENABLE_TRANSACTION_SIGNING=false
```

`AI_MODE=full` lets the model call Canix research tools in a multi-turn loop.
`AI_MODE=lite` has the host prefetch research (personalized + list) and makes a
single decide-only LLM call — lower ZeroSignal spend; prefer
`OPENAI_REASONING_EFFORT=high` for lite. `AI_MAX_TOOL_CALLS` only applies in full
mode.

`OPEN_AI_API_KEY` is a non-empty placeholder for the OpenAI SDK; zs-proxy ignores
it. The model receives discovered Canix402 data and quote-generation tools but
cannot access the mnemonic, payment signature, local signing, or Algod
submission. The host injects `BOT_WALLET`, `inferenceProvider: "zerosignal"`, and
planning guidance (position / protocol caps, liquid reserve, TVL and freshness
floors). Concentration and reserve limits are soft notes in the plan report.
With signing disabled, dry runs always surface the plan and do not call
execution quote endpoints; incomplete snapshot caveats and structural issues are
reported as policy notes. With signing enabled, incomplete portfolio data and
malformed actions still fail closed. Opportunities include enter
`executionShapes` (and `requiredAssetIds`); positions include
`compatibleExitShapeKeys` / `compatibleManageShapeKeys`. The host validates plan
shape keys against those catalogs and, when signing, calls
`canix_get_execution_quote` with a `quotes` array (flat ~0.10 USDC per request),
then signs each returned group in order.

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
x402 cap applies (default `MAX_DAILY_X402_BASE_UNITS`, 5 USDC). The bot validates
every live requirement against these limits before signing. Facilitator
fee-payer groups are supported.

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

Wallet / portfolio scan for `BOT_WALLET` (positions ~0.005 USDC + free Algod
balances). Uses the same reader as the daily review and prints completeness,
every caveat, protocol status, totals (including nulls), positions, and liquid
balances. Exit code `2` means the snapshot is incomplete; `1` means the scan
failed.

```bash
npm run canix:wallet-scan
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
balances and the Canix402 positions endpoint. Accounting history is stored in
DigitalOcean Spaces when configured, otherwise under `ACCOUNTING_DATA_DIR`. The
in-process latest-run response is operational convenience only and is lost on
restart. The scheduler and overlap lock assume a single service replica.

## Accounting snapshots

Accounting is always enabled. Persistence defaults to local JSON under
`data/accounting/` (override with `ACCOUNTING_DATA_DIR`). To use DigitalOcean
Spaces instead, set all four of `DO_SPACES_ENDPOINT`, `DO_SPACES_BUCKET`,
`DO_SPACES_KEY`, and `DO_SPACES_SECRET` (plus optional region/prefix):

```dotenv
ACCOUNTING_CRON_SCHEDULE="0 8 * * *"
ACCOUNTING_CRON_TIMEZONE="UTC"
# ACCOUNTING_DATA_DIR=data/accounting
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

Telegram is optional. Set both variables to enable it; otherwise the same report
text is printed to the terminal:

```dotenv
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

Review reports include the portfolio plan, expected net benefit, policy blocks
or notes, signing mode, action outcomes, transaction IDs, x402 totals, and
failures.
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

### Protocol verify (live round-trips)

Before shipping signing-enabled deploys, prove each protocol path with a
**dedicated** wallet (`TEST_WALLET` / `TEST_MNEMONIC` — do not reuse
`BOT_WALLET`):

1. Fund `TEST_WALLET` with ALGO (fees, stake, LP, swap), USDC (lending, LP,
   x402), and **ORA** (`1284444444`) for Myth dualSTAKE. Defaults size each leg
   at 1 ALGO / 1 USDC / 1 ORA (`PROTOCOL_VERIFY_AMOUNT_*`). Réti verify stakes at
   least **2 ALGO** (pool MBR can make a 1 ALGO first deposit fail on-chain).
   Validators may also require a higher `PROTOCOL_VERIFY_AMOUNT_ALGO` than their
   `minEntryStake`.
2. Pin opportunity IDs (paid Canix research):

```bash
npm run canix:discover-verify
```

   Writes `tests/fixtures/protocol-verify-opportunities.json`.
3. Run full enter→exit (and Haystack swap both ways) on the **same host path
   production uses**: agent-minimal plan actions (shape key + spends/amount only)
   → `normalizePortfolioPlan` shape completion → policy →
   `AlgorandExecutionService` (quotes + local sign + submit). A green suite
   means those pinned venues work when the live agent emits the same minimal
   fields (shape key, amounts, position id)—not a parallel verify-only builder.

```bash
RUN_PROTOCOL_VERIFY=true npm run test:protocol-verify
# Single case (also: test:protocol-verify:reti / :myth)
# RUN_PROTOCOL_VERIFY=true npm run test:protocol-verify:reti
```

Stops after the first failing case (`--bail=1`) so later protocols do not keep
spending. This suite is **not** CI. It spends real mainnet USDC/ALGO/ORA and
Canix x402 fees.

Cases: Folks USDC deposit, Folks ALGO stake, Tinyman LP, CompX lending, Dorkfi
USDC lending, PAct LP, Haystack ALGO↔USDC swap, **Réti pooling**, **Myth
dualSTAKE (ORA)**. (Tinyman LP+farm deferred.)

## Container (DigitalOcean)

The image bundles `zs-proxy` and starts it beside Brownie on loopback. Set the
usual bot env vars plus a keystore passphrase (file backend — no OS keychain in
containers):

```bash
docker build -t brownie-bot .
docker run --env-file .env \
  -e ZEROSIGNAL_KEYSTORE_PASSPHRASE='long-random-secret' \
  -p 3000:3000 brownie-bot
```

`docker/entrypoint.sh` imports `WALLET_MNEMONIC` into zs-proxy, waits for
`/healthz`, then runs `node dist/index.js`. Spend caps default from
`config/zs-proxy.yaml` (override with `PROXY_SPEND_*`). Fund the wallet on-chain
before the first review (`zs-proxy fund` from any machine with the same
mnemonic, or transfer USDC/ALGO to the address).

On-demand review (no `MANUAL_TRIGGER_TOKEN`): stop the long-running container if
needed, rebuild if the entrypoint changed, then:

```bash
# Safe connectivity smoke (LLM + one Canix research call; never signs)
docker run --rm --env-file .ENV brownie-bot smoke

# Full one-shot treasury review — set ENABLE_TRANSACTION_SIGNING=false first
docker run --rm --env-file .ENV brownie-bot once
```

`smoke` starts zs-proxy, runs `dist/smoke-llm.js` (ZeroSignal +
`canix_list_opportunities` only), prints JSON, and exits. `once` runs a full
review plan; with signing enabled it can move treasury assets.

For local non-Docker runs, install zs-proxy on the host instead — see
[QUICKSTART.md](./QUICKSTART.md).
