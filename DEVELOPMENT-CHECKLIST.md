# Development checklist

Product / operator QoL backlog for Brownie Bot. Check items off as they ship.
Keep this file updated when priorities change so work does not get lost across chats.

## Done recently

- [x] Telegram rich reports (`sendRichMessage`, tables, details, Allo links; HTML/plain fallback)
- [x] Durable last-run persistence (`wallets/<addr>/reviews/latest.json`, boot hydrate for `/runs/latest`)
- [x] **Sanitize upstream errors for humans** — ZeroSignal/Canix 502/504 HTML bodies → short classified messages (Telegram, logs, persisted `ReviewRun.error`); Docker also filters zs-proxy `err_body=` HTML dumps via `docker/sanitize-zs-logs.mjs`
- [x] **Real `/health`** — last review/accounting age + status; optional `?deps=1` probes for zs-proxy, Algod, Canix
- [x] **Telegram inbound commands** — long-poll `/help` `/status` `/history` `/run` `/accounting` from `TELEGRAM_CHAT_ID` on the long-lived server
- [x] **Tinyman farm claim host path** — synthesize `claim` executionInput from reward `positionId` / notes; claim must bind reward row not farmed LP
- [x] **Preferred hold steer** — `PREFERRED_HOLD_ASSETS=assetId:pct,…` soft targets in hostGuidance + prompt guidance that swaps can rotate idle non-preferred ASAs; preferred % counts liquid + LP/farm/lend exposure; below-target preferred holds override deep-liquidity preference (accumulate / build thin markets / prefer preferred LP & lend); lend+borrow are first-class vs swap-away; buys into preferred-hold ASAs waive Haystack `MAX_PRICE_IMPACT_PCT`; open/increase into opportunities including preferred ASAs waive `MIN_TVL_USD`
- [x] **Held-position increase path** — host research pins/fetches opportunityIds already in the snapshot; synthesize Réti (etc.) enter `executionInput` from position hints; policy allows catalog-miss `increase` on held positions instead of blocking the whole plan
- [x] **Pause / kill-switch** — runtime hold (no trading / plan-only) via Telegram `/pause` `/resume`; durable under `ACCOUNTING_DATA_DIR`
- [x] **Cashflow-aware P&L** — `/deposit` `/withdraw` + txid inference; accounting P&L adjusts for recorded funding
- [x] **Easier force-run (Telegram)** — `/run` `/accounting` ack immediately and finish in background so the command loop stays responsive
- [x] **Deterministic DeFi unwind** — `/unwind` host-built close-all (positions + LST; multi-wave; confirm)
- [x] **Spend visibility** — daily/remaining Canix x402 + zs-proxy caps on `/status` and `/health` (UTC day; persisted under `ACCOUNTING_DATA_DIR`)
- [x] **Config empathy** — required vs optional env split, friendlier Zod errors, ops troubleshooting section in docs
- [x] **Dated review history** — `wallets/<addr>/reviews/<yyyy>/<mm>/<dd>/<runId>.json` plus `latest.json`; 7-day rotate; `GET /runs` and Telegram `/history` summaries
- [x] **HTTP/Docker force-run docs** — `MANUAL_TRIGGER_TOKEN` (`POST /runs`, Bearer, 404/401/409) and Docker `once` vs long-lived server (stdout mix + `sanitize-zs-logs.mjs`); Telegram `/run` remains the chat-side path

## Next (recommended order)

1. [ ] **Health low-balance warnings** — optional follow-up when wallet ALGO/USDC checks are cheap enough to add to `?deps=1`.

## Parking lot

- [ ] Human approval step before signed submit (beyond policy approval)
- [ ] Dashboard / UI (Telegram + HTTP remain primary unless this becomes a goal)
- [ ] Multi-replica / distributed lock for cron overlap

## Notes

- Prefer small vertical slices that improve day-2 operator trust over large refactors.
- Telegram Desktop needs a client that supports rich messages; fallbacks cover older clients.
- Durable last-run unlocks health “last success age” without inventing new storage.
- Docker `once`/server stdout mixes zs-proxy + brownie-bot; brownie sanitizes its own errors, and `sanitize-zs-logs.mjs` filters proxy `err_body=` HTML.
