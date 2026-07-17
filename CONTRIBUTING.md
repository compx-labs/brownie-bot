# Contributing

Thanks for helping improve Brownie Bot. This guide is for people changing the
code. To **run** the bot as an operator, start with
[QUICKSTART.md](./QUICKSTART.md).

## Ground rules

- **Never commit secrets.** Keep `.env` / `.ENV` local. Use `.env.example` as
  the template only.
- **Do not paste mnemonics, API keys, or payment signatures** into issues, PRs,
  logs, or screenshots.
- **Default to dry-run.** Leave `ENABLE_TRANSACTION_SIGNING=false` unless you
  are deliberately testing execution with a wallet you control.
- **Paid Canix402 calls spend real mainnet USDC.** Prefer the mocked unit suite
  while developing. See [Expected costs](./QUICKSTART.md#expected-costs).

## Development setup

```bash
nvm use   # Node 22+
npm install
cp .env.example .env
# fill BOT_WALLET, WALLET_MNEMONIC, OPEN_AI_API_KEY for local dry-runs
```

Optional: Telegram and DigitalOcean Spaces. Without them, reports go to the
terminal and accounting JSON lands under `data/accounting/`.

## Checks before you open a PR

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

The same checks run on GitHub Actions for pushes and pull requests to `main`
(see `.github/workflows/ci.yml`). Live Canix smoke is **not** part of CI.

- `npm test` mocks paid Canix402 behavior and should **not** spend funds.
- `RUN_LIVE_SMOKE=true npm run test:smoke` hits the free health tool only — still
  network-dependent; run it manually when needed, never as required PR CI.
- CLI scripts (`canix:opportunities`, `canix:personalized`, `canix:wallet-scan`)
  and `npm run run-once` **do** spend USDC. Use them intentionally on a funded
  test wallet.

## Project map (short)

| Area | Location |
| --- | --- |
| HTTP app + wiring | `src/app.ts` |
| Config | `src/config.ts`, `.env.example` |
| Portfolio agent prompt | `src/services/portfolio-agent.ts` |
| Policy validation | `src/services/portfolio-policy.ts` |
| Canix402 MCP + x402 | `src/integrations/canix402/` |
| Accounting + storage | `src/services/accounting.ts`, `src/integrations/storage/` |
| Tests | `tests/` |

## Pull requests

1. Keep changes focused; match existing TypeScript style.
2. Add or update tests when behavior changes (policy, payments, config).
3. Update docs (`README.md`, `QUICKSTART.md`, `.env.example`) when you change
   operator-facing setup, costs, or env vars.
4. Describe **why** in the PR body, and note if you ran any live/mainnet commands.

## License

By contributing, you agree that your contributions are licensed under the MIT
License ([LICENSE](./LICENSE)).
