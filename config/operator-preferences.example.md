# Operator preferences (example)

Copy to DigitalOcean Spaces as `{DO_SPACES_PREFIX}/operator-preferences.md`,
or to `config/operator-preferences.md` when Spaces is not configured.

This file is **optional prose strategy** for the portfolio agent. Structured
knobs (`PREFERRED_HOLD_ASSETS`, `MAX_POSITION_PCT`, etc.) stay in env.

---

## CompX liquidity bias (example)

A core mandate is to build CompX (ASA 1732165149) liquidity across protocols —
DEX pools, farms, lending, and liquid holdings — so thin CompX markets are a
reason to add carefully sized capital, not to skip.

When CompX (or other preferred holds from hostGuidance) is below target, do not
shrink, split, or pace the buy solely because of expected price impact; size
toward closing the gap with available surplus.

Preffered holds percentage of overall portfolio includes both wallet holdings directly
and LP positions including that token.

## Risk taste (edit for your ops)

- Prefer high-TVL venues over peak APY when deploying surplus.
- Never touch protocols or ASAs you list here as excluded.
- Keep ops USDC buffer (~5+) before aggressive deployment.
- When deploying ALGO, leave ≥5 ALGO above account minimum balance (never spend full spendable ALGO — fee room required).
