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
table. Short version (pull published image):

```bash
cp .env.example .env
# set BOT_WALLET, WALLET_MNEMONIC, ZEROSIGNAL_KEYSTORE_PASSPHRASE
# fund the wallet on-chain once (see QUICKSTART)
docker compose up -d
# or: docker pull ghcr.io/compx-labs/brownie-bot:latest && docker run --env-file .env -p 3000:3000 ghcr.io/compx-labs/brownie-bot:latest
```

To build locally instead: `docker build -t brownie-bot .` then
`docker run --env-file .env -p 3000:3000 brownie-bot`.

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
OPENAI_MODEL="glm-5.2"
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

Optional soft steer for preferred-asset exposure (not hard policy). Target % is
economic exposure (liquid + LP/farm/lend), not bag-only. When below target, the
agent should accumulate even if secondary liquidity is thin (builds that
market); buys into these ASAs waive the Haystack price-impact cap:

```dotenv
# assetId:targetPortfolioPct pairs — e.g. hold ~15% GOLD$
PREFERRED_HOLD_ASSETS=246516580:15
```

Optional **operator preferences** prose (CompX liquidity bias, exclusions, risk
taste) is loaded by convention — there is no prefs env var. When Spaces is
configured, each review reads `{DO_SPACES_PREFIX}/operator-preferences.md`.
Otherwise it tries `config/operator-preferences.md` relative to the process cwd.
Missing or empty → disregarded. See
[`config/operator-preferences.example.md`](./config/operator-preferences.example.md).

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

The same Spaces bucket/prefix also hosts optional
`{DO_SPACES_PREFIX}/operator-preferences.md` (prose strategy for the portfolio
agent). Without Spaces, drop `config/operator-preferences.md` (gitignored; copy
from [`config/operator-preferences.example.md`](./config/operator-preferences.example.md)).

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
not fail the run. P&L is cashflow-aware: recorded external deposits/withdrawals
in the window adjust the NAV delta so funding is not profit. Prefer Telegram
`/deposit <txid>` / `/withdraw <txid>` (or `POST /accounting/cashflows` for
manual overrides including profit-share withdrawals).

### Multi-window P&L and inception

Each accounting summary includes cashflow-aware windows **`7d`**, **`30d`**, and
**`all`** (plus a weekly `navSeries` for charts). Rolling windows need prior
snapshots; all-time needs an **inception** baseline.

Bootstrap (verify then commit):

```bash
# Defaults: min-round 63163056, asOf 2026-07-16T21:21:50.000Z
npm run accounting-inception-review

# Inspect the JSON (external_* vs flagged protocol groups), then:
npm run accounting-inception-review -- --commit
# Optional: --inception-nav 1234.56 --force --review path/to/review.json

npm run accounting-once
```

Telegram `/inception` shows the stored baseline. `GET /accounting/inception`
returns it over HTTP.

### Public PnL JSON (website)

After each successful accounting run the bot also writes a **redacted** public
artifact at `{DO_SPACES_PREFIX}/public/pnl.json` (locally:
`{ACCOUNTING_DATA_DIR}/{prefix}/public/pnl.json`). Private wallet snapshots and
summaries stay private; only this object is uploaded with `ACL: public-read`
and `Cache-Control: public, max-age=60`. Point an external website at the CDN
URL — do not expose the bot HTTP port for this.

Public payload (`schemaVersion: 2`): `walletAddress`, `asOf`, `navUsd`,
`previousNavUsd`, vs-previous `pnlUsd`, `windows` (`7d` / `30d` / `all`),
`navSeries`, protocol/wallet totals. Internal notes, checksums, and snapshot
keys are omitted.

#### DigitalOcean Spaces setup

Do this once on the Space used by `DO_SPACES_*`. Keep the Space **private**
overall; only `public/pnl.json` is world-readable via object ACL.

1. **Confirm the Space** — Control Panel → **Spaces Object Storage** → open
   `DO_SPACES_BUCKET` (region must match `DO_SPACES_REGION`, e.g. `nyc3`).
2. **Do not make the whole Space public** — private Space + per-object
   `public-read` on upload keeps `wallets/...` inaccessible.
3. **Enable CDN** (recommended) — Space → **Settings** → **CDN** → Enable.
   Public URL:
   ```text
   https://{bucket}.{region}.cdn.digitaloceanspaces.com/{DO_SPACES_PREFIX}/public/pnl.json
   ```
   Non-CDN:
   ```text
   https://{bucket}.{region}.digitaloceanspaces.com/{DO_SPACES_PREFIX}/public/pnl.json
   ```
   Example with defaults:
   `https://your-bucket.nyc3.cdn.digitaloceanspaces.com/brownie-bot/public/pnl.json`
4. **CORS** (required for browser `fetch`) — Space → **Settings** → **CORS
   Configurations** → add a rule:
   - Allowed Origins: your site origin(s), e.g. `https://yoursite.com`
   - Allowed Methods: `GET`, `HEAD`
   - Allowed Headers: `*` (or default)
   - Max Age: `3600`
5. **Force one accounting run** after deploy — `POST /accounting/run` (bearer
   token), Telegram `/accounting`, or wait for the accounting cron. Confirm
   `{prefix}/public/pnl.json` appears in the Spaces browser with public read.
6. **Smoke-test**:
   ```bash
   curl -i "https://{bucket}.{region}.cdn.digitaloceanspaces.com/{prefix}/public/pnl.json"
   ```
   Expect `200` and `Content-Type: application/json`. CDN may cache up to ~60s.

## HTTP API

- `GET /health` — operator health: config readiness, busy flag, latest
  review/accounting age and status (from in-memory / hydrated state). Does
  not contact deps by default. Append `?deps=1` to also probe zs-proxy
  `/healthz`, Algod `/health`, and free `canix_health` (short timeouts; may
  mark `status` as `degraded` with `warnings` when something is down or
  stale). Always HTTP 200 while the process is up — check the `status`
  field (`ok` | `degraded`).
- `GET /runs/latest` — latest review result (hydrated from
  `wallets/<addr>/reviews/latest.json` on boot; updated after each review)
- `POST /runs` — manually run a review; disabled unless
  `MANUAL_TRIGGER_TOKEN` is set and requires
  `Authorization: Bearer <token>`
- `GET /accounting/latest` — latest accounting run
- `GET /accounting/inception` — all-time inception baseline (404 if unset)
- `POST /accounting/run` — manually run accounting; same bearer token model
- `POST /accounting/cashflows` — record an immutable external cashflow event

Latest review JSON is stored alongside accounting under the same local
`ACCOUNTING_DATA_DIR` (or Spaces) root. Persistence is best-effort: a store
write failure is logged and does not fail the review.

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

When Telegram is configured, the **long-lived server** (`npm start` / Docker
default `dist/index.js`) also long-polls for operator slash commands from
`TELEGRAM_CHAT_ID` only:

| Command       | Behavior                                                      |
| ------------- | ------------------------------------------------------------- |
| `/help`       | List commands                                                 |
| `/status`     | Health / busy / paused / signing / last-run ages              |
| `/run`        | Force a treasury review (acks immediately; digest follows)    |
| `/accounting` | Force an accounting snapshot (acks immediately; digest follows) |
| `/deposit <txid>` | Record external funding from a pay/axfer transaction      |
| `/withdraw <txid>` | Record external withdrawal from a pay/axfer transaction |
| `/unwind`     | Preview host close-all (positions + LST receipts); then `/unwind confirm` |
| `/unwind confirm` | Execute pending unwind (multi-wave until flat or stuck) |
| `/unwind cancel` | Discard pending unwind preview |
| `/pause`      | Hold trading; reviews continue as plan-only                   |
| `/resume`     | Clear the hold (signing still requires `ENABLE_TRANSACTION_SIGNING`) |

Pause is a durable runtime kill-switch (wallet-scoped JSON under
`ACCOUNTING_DATA_DIR`). It does not change the env signing flag; `/resume`
only restores trading when signing is already enabled.

`/unwind` is host-built (no LLM): one next exit/claim step per position per
wave (claim → farm uncommit → close), plus known LST receipt unstakes (e.g.
xALGO). Confirm requires signing enabled and not paused; the runner loops
foundation waves until nothing remains, a stuck fingerprint, or a wave cap.
Residual non-LST ASAs are not Haystack-swapped to cash in v1.

`/deposit` and `/withdraw` look up the confirmed Algorand transaction via
`X402_INDEXER_URL` (default AlgoNode indexer), infer ALGO/ASA amount, price it
to USD, and store an immutable cashflow keyed by txid. Paste the **payment or
ASA transfer** txid (not an unrelated group sibling). Accounting P&L then
subtracts deposits and adds withdrawals so funding is not treated as profit or
loss.

One-shot entrypoints (`once`, smoke) do not start the command loop. On boot,
pending updates are drained so a redeploy does not replay stale `/run`s.

When Telegram is configured, review and accounting digests are sent as Telegram
**rich messages** (`sendRichMessage`: `###` section headings, tables, collapsible
details, Allo links). If rich delivery fails, the bot falls back to HTML
`sendMessage`, then plain text.

Review reports include the portfolio plan, expected net benefit, policy blocks
or notes, signing mode, action outcomes, transaction IDs, x402 totals, and
failures.
Accounting reports include DeFi value by protocol, wallet token total (including
ALGO USD), ALGO and minimum balance in token units, cashflow-aware P&L versus the
previous snapshot (plus net external funding when non-zero), unpriced assets,
and the Spaces snapshot key. Telegram delivery errors are stored without
replacing the underlying result.

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

Writes `tests/fixtures/protocol-verify-opportunities.json`. 3. Run full enter→exit (and Haystack swap both ways) on the **same host path
production uses**: agent-minimal plan actions (shape key + spends/amount only)
→ `normalizePortfolioPlan` shape completion → policy →
`AlgorandExecutionService` (quotes + local sign + submit). A green suite
means those pinned venues work when the live agent emits the same minimal
fields (shape key, amounts, position id)—not a parallel verify-only builder.

```bash
RUN_PROTOCOL_VERIFY=true npm run test:protocol-verify
# Single case (also: test:protocol-verify:reti / :myth / :compx-credit / :dorkfi-credit / :folks-credit)
# RUN_PROTOCOL_VERIFY=true npm run test:protocol-verify:reti
# RUN_PROTOCOL_VERIFY=true npm run test:protocol-verify:dorkfi-credit
```

Stops after the first failing case (`--bail=1`) so later protocols do not keep
spending. This suite is **not** CI. It spends real mainnet USDC/ALGO/ORA and
Canix x402 fees.

Cases: Folks USDC deposit, Folks ALGO stake, Tinyman LP, CompX lending, CompX
credit, Dorkfi USDC lending, **DorkFi credit (USDC→UNIT)**, PAct LP, Haystack
ALGO↔USDC swap, **Réti pooling**, **Myth dualSTAKE (ORA)**. Tinyman farm
**claimRewards** is live on reward positions; farm stake/unstake protocol-verify
remains deferred.

## Container (DigitalOcean)

Published images: `ghcr.io/compx-labs/brownie-bot:latest` (also tagged with git
sha / `v*` releases). The image bundles `zs-proxy` and starts it beside Brownie
on loopback. Set the usual bot env vars plus a keystore passphrase (file backend
— no OS keychain in containers):

```bash
cp .env.example .env
# set BOT_WALLET, WALLET_MNEMONIC, ZEROSIGNAL_KEYSTORE_PASSPHRASE
docker compose up -d
# or pull + run:
docker pull ghcr.io/compx-labs/brownie-bot:latest
docker run --env-file .env \
  -e ZEROSIGNAL_KEYSTORE_PASSPHRASE='long-random-secret' \
  -p 3000:3000 ghcr.io/compx-labs/brownie-bot:latest
```

Local-only prefs (no Spaces): bind-mount
`./config/operator-preferences.md` (see `docker-compose.yml`). With Spaces,
upload `{prefix}/operator-preferences.md` instead — no volume required.

`docker/entrypoint.sh` imports `WALLET_MNEMONIC` into zs-proxy, waits for
`/healthz`, then runs `node dist/index.js`. Spend caps default from
`config/zs-proxy.yaml` (override with `PROXY_SPEND_*`). Relay privacy defaults
**off** (`zs.privacy: false`; override with `PROXY_ZS_PRIVACY=true`). Fund the wallet on-chain
before the first review (`zs-proxy fund` from any machine with the same
mnemonic, or transfer USDC/ALGO to the address).

On-demand review (no `MANUAL_TRIGGER_TOKEN`): stop the long-running container if
needed, rebuild if the entrypoint changed, then:

```bash
# Safe connectivity smoke (LLM + one Canix research call; never signs)
docker run --rm --env-file .env ghcr.io/compx-labs/brownie-bot:latest smoke

# Full one-shot treasury review (build image + zs-proxy + run-once; uses .env as-is)
npm run run-once-with-docker
```

`smoke` starts zs-proxy, runs `dist/smoke-llm.js` (ZeroSignal +
`canix_list_opportunities` only), prints JSON, and exits. `run-once-with-docker`
builds the image and runs `once` (full review); with signing enabled it can move
treasury assets.

For local non-Docker runs, install zs-proxy on the host instead — see
[QUICKSTART.md](./QUICKSTART.md).
