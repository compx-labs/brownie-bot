# Development checklist

Product / operator QoL backlog for Brownie Bot. Check items off as they ship.
Keep this file updated when priorities change so work does not get lost across chats.

## Done recently

- [x] Telegram rich reports (`sendRichMessage`, tables, details, Allo links; HTML/plain fallback)
- [x] Durable last-run persistence (`wallets/<addr>/reviews/latest.json`, boot hydrate for `/runs/latest`)
- [x] **Sanitize upstream errors for humans** — ZeroSignal/Canix 502/504 HTML bodies → short classified messages (Telegram, logs, persisted `ReviewRun.error`); Docker also filters zs-proxy `err_body=` HTML dumps via `docker/sanitize-zs-logs.mjs`
- [x] **Real `/health`** — last review/accounting age + status; optional `?deps=1` probes for zs-proxy, Algod, Canix

## Next (recommended order)

1. [ ] **Pause / kill-switch** — runtime hold (no trading / plan-only) without redeploy; clearer than flipping `ENABLE_TRANSACTION_SIGNING` alone.
2. [ ] **Cashflow-aware P&L** — accounting P&L should adjust for recorded deposits/withdrawals so funding is not profit.
3. [ ] **Easier force-run** — document / default path for `MANUAL_TRIGGER_TOKEN` and Docker `once`; optional operator CLI for status/trigger.
4. [ ] **Spend visibility** — daily/remaining Canix x402 + ZeroSignal caps beyond per-run lines.
5. [ ] **Config empathy** — required vs optional env split, friendlier Zod errors, ops troubleshooting section in docs.
6. [ ] **Dated review history** — optional follow-up to latest-only persistence (`reviews/<yyyy>/<mm>/<dd>/<runId>.json` + list API).
7. [ ] **Health low-balance warnings** — optional follow-up when wallet ALGO/USDC checks are cheap enough to add to `?deps=1`.

## Parking lot

- [ ] Human approval step before signed submit (beyond policy approval)
- [ ] Dashboard / UI (Telegram + HTTP remain primary unless this becomes a goal)
- [ ] Multi-replica / distributed lock for cron overlap

## Notes

- Prefer small vertical slices that improve day-2 operator trust over large refactors.
- Telegram Desktop needs a client that supports rich messages; fallbacks cover older clients.
- Durable last-run unlocks health “last success age” without inventing new storage.
- Docker `once`/server stdout mixes zs-proxy + brownie-bot; brownie sanitizes its own errors, and `sanitize-zs-logs.mjs` filters proxy `err_body=` HTML.
