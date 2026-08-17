# Operator preferences (example)

Copy to DigitalOcean Spaces as `{DO_SPACES_PREFIX}/operator-preferences.md`,
or to `config/operator-preferences.md` when Spaces is not configured.

This file is **optional prose strategy** for the portfolio agent. Structured
knobs (`PREFERRED_HOLD_ASSETS`, `MAX_POSITION_PCT`, etc.) stay in env.

---

## Non-preferred thin liquidity

Do not open LP or farm positions involving non-preferred ASAs when pool/farm TVL
is thin or the ASA is exotic/experimental. Prefer high-TVL venues over peak APY
when deploying surplus.

Preferred-list ASAs (from `PREFERRED_HOLD_ASSETS` / hostGuidance) are the
exception: **host policy waives `MIN_TVL_USD` for open/increase into opportunities
whose `assetIds` include a preferred hold**. Treat thin preferred markets as a
reason to add carefully sized capital that builds liquidity, not as a skip or
block. Do not reject or deprioritize preferred LP/farm/lend solely because TVL is
below the global floor.

## CompX — home token / platform liquidity

CompX (ASA **1732165149**) is the home token of this bot's own platform
(CompX / Canix). Building its on-chain liquidity is a **core mandate**, not a
nice-to-have: DEX pools, farms, lending markets, and liquid holdings all count.
Thin CompX markets are expected while liquidity is being bootstrapped — add
carefully sized capital; do not skip because TVL looks small or APY is 0%.

Prefer ALGO/COMPX LP/farm (and other CompX DeFi) over parking idle CompX in the
wallet. When CompX (or other preferred holds from hostGuidance) is below target,
do not shrink, split, or pace the buy solely because of expected price impact;
size toward closing the gap with available surplus.

Ensure part of our treasury is in COMPX/ALGO liquidity on Tinyman. The host
searches `platform=tinyman&assetIds=1732165149` so this pool is visible even
when it is outside Tinyman’s top-N list (`ZKAP7…:lp`).

Preferred holds percentage of overall portfolio includes wallet holdings and LP
(and lend) positions that include that token.

DO NOT SELL COMPX (ASA **1732165149**).

## Preferred-asset opportunity discovery (MCP)

The host already searches each preferred hold (and Tinyman COMPX/ALGO when CompX
is preferred). Generic `canix_list_opportunities` / personalized top-N often
omit thinner preferred-asset LP and lend rows — use host `preferredOpportunities`
and dedicated `canix_search_opportunities` with `assetIds` (e.g. `1732165149`
for CompX). Do not conclude "no LP available" from a high-TVL-only list.

## CompX lending / borrow

CompX can be supplied on CompX lending as collateral to **borrow other tokens**
(e.g. ALGO or USDC). Treat lend+borrow as a real alternative to swapping CompX
away: when the goal is working capital in another asset while keeping CompX
exposure, prefer collateralize CompX and borrow rather than sell/swap CompX —
subject to health/LTV risk. Consider lending and borrowing opportunities, not
only LP and spot holds. Low or 0% supply APY is fine when the goal is building
CompX lending liquidity and enabling future borrow.

Executable **debt** rows (`positionType: debt`) from CompX, Folks, and DorkFi
are real liabilities. Repay from `compatibleExitShapeKeys`; do not treat
`usdValue: null` as zero and do not invent size from wallet UNIT.

## Claims

When the claim desk is present, prefer `worthClaiming` rows (Tinyman farm,
stALGO TINY, CompX staking, Pact farm, Haystack, Alpha Arcade). Réti is not on
the desk. Host compiles selected claims in one quote request.

## Risk taste (edit for your ops)

- Prefer high-TVL venues over peak APY when deploying surplus **into non-preferred ASAs**.
- Never touch protocols or ASAs you list here as excluded.
- Keep ops USDC buffer (~5+) before aggressive deployment.
- When deploying ALGO, leave ≥5 ALGO above account minimum balance (never spend full spendable ALGO — fee room required).
