# Portfolio policy

Host-side gates that run **after** the agent returns a structured `portfolio_plan` and **before** any signing/submission. Source of truth: `src/services/portfolio-policy.ts` (`PortfolioPolicy.validate`).

Telegram digests only **report** policy outcomes. They do not feed the agent and do not affect approval.

## Pipeline position

```
Agent plan JSON
  → schema parse (+ coerce/repair)
  → normalizePortfolioPlan (shape completion, drop redundant setup/opt-in)
  → PortfolioPolicy.validate
  → if approved + signing enabled → AlgorandExecutionService
       (foundation wave only: actions with empty dependencies;
        dependents skip as deferred until a later review)
```

If schema parse fails, status is `reported` and **policy never runs** (`Policy n/a`). That is not a policy block.

When signing is enabled, the host executes only **no-dependency** actions in the approved plan. Actions that depend on earlier plan steps are marked `skipped` with `Deferred to next review (depends on earlier plan steps)`. The next review sees a fresh snapshot (and optional `priorReview` continuity in the agent task) and can replan sizes against live balances. Dry-run still validates the full plan without deferred skips.

## Approval model

| Mode | Config | Effect |
| --- | --- | --- |
| Signing enabled | `ENABLE_TRANSACTION_SIGNING=true` | `approved` only when **hard** violations are empty. Soft items stay warnings. |
| Signing disabled (dry-run) | `ENABLE_TRANSACTION_SIGNING=false` | Always `approved: true`. Hard issues are rewritten as warnings: `Would block if signing enabled: …`. |

Returned fields:

- `violations` — hard blocks (empty when signing disabled)
- `warnings` — soft guidance / dry-run would-blocks
- `metrics` — `maxPositionPct`, `maxProtocolPct`, `liquidReservePct`, `turnoverPct` (computed from target/current allocations; informational)

### Incomplete snapshot override

`blockIncompleteSnapshot` defaults to `signingEnabled`. Protocol-verify sets it `false` so partial valuations do not stall enter→exit tests. Production app wiring uses the default (block when signing).

---

## Config knobs

| Env / config | Default | Role |
| --- | --- | --- |
| `MAX_POSITION_PCT` | `35` | Soft: max single **deployed** target allocation weight (`protocol !== null`) |
| `MAX_PROTOCOL_PCT` | `50` | Soft: max sum of target weights per protocol |
| `MIN_LIQUID_RESERVE_PCT` | `10` | Soft: min sum of target weights with `protocol === null` |
| `MIN_TVL_USD` | `6000` | Hard (open/increase): opportunity TVL floor; **waived** when the opportunity’s `assetIds` intersect `PREFERRED_HOLD_ASSETS` |
| `MAX_SOURCE_AGE_HOURS` | `24` | Hard (open/increase): opportunity `sourceTimestamp` age; also used when building snapshot caveats for stale positions |
| `MIN_PROJECTED_NET_IMPROVEMENT_USD` | `1` | Soft: when any non-`hold` action exists |
| `ENABLE_TRANSACTION_SIGNING` | required | Switches hard vs soft treatment (see above) |
| `PREFERRED_HOLD_ASSETS` | empty | Soft agent steer; waives Haystack price-impact on buys into listed ASAs; waives `MIN_TVL_USD` on open/increase into opportunities that include those ASAs |

Execution-time (not `PortfolioPolicy`, but related operator limits):

| Env | Default | Role |
| --- | --- | --- |
| `MAX_SLIPPAGE_BPS` | `100` | Passed into quote inputs / swap paths |
| `MAX_PRICE_IMPACT_PCT` | `3` | Hard fail at execution for Haystack quotes above impact (waived when swap `toAssetId` is in `PREFERRED_HOLD_ASSETS`) |
| `MAX_DAILY_X402_BASE_UNITS` | `5000000` | x402 spend budget (payments), not portfolio concentration |

---

## Pre-policy normalization (`normalizePortfolioPlan`)

Runs before validate. Does **not** approve/reject; it rewrites the plan:

1. **Drop redundant prerequisite enters** — standalone `open`/`increase` whose shape `action` is `setup` / `optin` / `create` / `create-escrow` are removed when another capital enter for the same opportunity remains (host expands prerequisites at quote time).
2. **Complete `executionInput`** — fill missing Canix shape `requiredInputs` from `inputHints`, `authorizedSpends`, `amountRaw`, snapshot (via `completeActionExecutionInput`); backfill `opportunityId` from the bound position; synthesize enter shapes for `increase` when the researched catalog omitted a held opportunity. For **claim-all** manage shapes (no amount in `requiredInputs`), clear `amountRaw` (including LLM `"0"`) so zero-amount policy does not hard-block the rest of the plan.
3. **Sanitize dependencies** — remove deps that are not action IDs in the plan (e.g. shape keys); remove deps pointing at dropped prerequisite actions.

---

## Hard blocks (`violations`)

When signing is enabled, any of these → `approved: false` → run status typically `planned`, no txs.

### Allocations

| Rule | Message pattern |
| --- | --- |
| Duplicate current allocation keys | `Duplicate current allocation key: …` |
| Duplicate target allocation keys | `Duplicate target allocation key: …` |
| Target allocation protocol ≠ researched opportunity protocol | `Target allocation … has a protocol mismatch` |

Current/target weight totals are **not** hard-gated (rounding and partial plans often land near but not exactly 100%).

### Plan / action structure

| Rule | Applies to | Message pattern |
| --- | --- | --- |
| Duplicate action IDs | all | `Duplicate action ID: …` |
| Dependency on self | all | `Action … has invalid dependencies: depends on itself` |
| Dependency ID not in plan | all | `Action … depends on … but the plan only defines action ID(s) …` |
| `amountRaw === "0"` | non-hold (after normalize; claim-all amounts are cleared to null first) | `Action … has a zero amount` |
| Duplicate `authorizedSpends` asset IDs | non-hold | `Action … has duplicate authorized spends` |
| Missing `executionShapeKey` and/or `executionInput` | non-hold, non-swap | `Action … has no executable shape (missing …)` |

### Swaps

| Rule | Message pattern |
| --- | --- |
| Need distinct `fromAssetId` / `toAssetId` and non-null `amountRaw` | `Swap action … is incomplete` |
| Exactly one `authorizedSpends` entry matching `fromAssetId` + `amountRaw` | `Swap action … authorized spend does not match its input` |

Swaps are validated separately and **do not** require an execution shape key in this policy pass.

### Open / increase (enter)

| Rule | Message pattern |
| --- | --- |
| `opportunityId` must be in researched MCP opportunities | `Action … does not reference a researched opportunity` / `… opportunity not returned by MCP` |
| **Exception:** `increase` on an existing snapshot position with shape+input (catalog miss) | Soft: `… increases held position … without a researched opportunity catalog entry` |
| Action protocol must match opportunity protocol | `Action … has a protocol mismatch` |
| Opportunity must be `executionReady` with non-empty `executionShapes` | `… research-only (executionReady=false or empty executionShapes)` |
| `executionShapeKey` must be in opportunity enter shapes | `… is not in opportunity … enter shapes […]` |
| Declared treasury spend when capital is transferred | `Action … has no declared treasury spend` |
| Opportunity TVL ≥ `MIN_TVL_USD` (unless opportunity `assetIds` intersects `PREFERRED_HOLD_ASSETS`) | `Action … TVL is below $…` |
| Opportunity source age ≤ `MAX_SOURCE_AGE_HOURS` | `Action … opportunity data is stale (…h)` |

**When is declared spend required?** (`authorizedSpends` non-empty):

- `amountRaw` is present and &gt; 0, **or**
- the chosen shape has a `requiredInputs` entry matching `/amount/i`

Setup-only / zero-amount prerequisite-style enters that survive normalization may not need spends.

**Missing required assets** (selected enter shape `requiredAssetIds`, not covered by liquid balances or a dependency `swap` producing the asset):

- Uses the action’s `executionShapeKey` shape when present; otherwise unions all opportunity enter shapes (conservative fallback).
- **Single-sided** enters (`singleAsset` / `addLiquidityAndFarm:singleAsset`): narrowed to the deposit asset (`executionInput.depositAssetId`, else `fromAssetId`, else a single `authorizedSpends` asset)—so Canix listing both pool ASAs does not require the other side in wallet.
- Signing enabled → **hard**
- Signing disabled → **soft** warning only

Message: `Action … requires asset ID(s) … but liquid balances lack them and no dependency swap produces them`

### Reduce / close / claim (exit / manage)

| Rule | Message pattern |
| --- | --- |
| `positionId` must exist on the current snapshot | `Action … does not reference a current position` |
| Action protocol must match position protocol | `Action … has a protocol mismatch` |
| Position must expose exit/manage catalogs when a shape key is set | `… with no compatibleExitShapeKeys/compatibleManageShapeKeys` |
| `executionShapeKey` must be in those catalogs | `… is not in position … exit/manage keys […]` |

**`authorizedSpends` is not required** for reduce/close/claim. Withdraw/manage sizing uses `amountRaw` / `executionInput`.

### Incomplete snapshot

When `snapshot.complete === false` and the plan has any non-`hold` action:

| `blockIncompleteSnapshot` (default = signing) | Severity | Message |
| --- | --- | --- |
| `true` | **Hard** | `Portfolio snapshot is incomplete (…); only hold is permitted while signing` |
| `false` and signing on | Soft | `…; continuing despite incomplete snapshot` |
| signing off | Soft | `…; signing is disabled so the plan is still reported` |

Caveat text is joined from `snapshot.caveats` (see below).

---

## Soft warnings (`warnings`)

These **never** alone set `approved: false` when signing is enabled (they appear under Risks / policy notes in Telegram).

| Rule | Message pattern |
| --- | --- |
| Max deployed target weight &gt; `MAX_POSITION_PCT` | `Target position …% exceeds guidance of …%` |
| Max per-protocol target weight &gt; `MAX_PROTOCOL_PCT` | `Target protocol allocation …% exceeds guidance of …%` |
| Liquid (`protocol === null`) target weight &lt; `MIN_LIQUID_RESERVE_PCT` | `Liquid reserve …% is below guidance of …%` |
| Non-hold plan with `projectedNetBenefitUsd` &lt; `MIN_PROJECTED_NET_IMPROVEMENT_USD` | `Projected net benefit is below guidance of $…` |
| Target allocation `opportunityId` not in researched set and not an existing position opportunity | `Target allocation … references an unknown opportunity` |
| Missing required assets (dry-run only) | see enter section |
| Incomplete snapshot when not hard-blocking | see incomplete section |
| Any hard rule when signing disabled | `Would block if signing enabled: …` |

Liquid allocations are a **reserve floor**, not counted toward the position-size cap.

---

## Snapshot completeness (feeds incomplete-snapshot policy)

Built in `AlgorandPortfolioReader` (`src/integrations/algorand/portfolio.ts`). Any caveat → `complete: false`.

| Caveat source | Example |
| --- | --- |
| Account is rekeyed | `Treasury account is rekeyed to …` |
| Canix protocol status ≠ `ok` (`partial` / `unavailable`) | `{protocol} positions are partial: …` |
| Position `sourceTimestamp` older than `MAX_SOURCE_AGE_HOURS` | `Position … source data exceeds … hours` |
| Any aggregate total valuation is `null` | `At least one aggregate position valuation is incomplete` |

Partial Canix protocol messages (e.g. missing debt/health index) currently mark the whole snapshot incomplete and can hard-block signing runs even when the operator believes debt is irrelevant. That is host policy reacting to Canix status, not a separate “debt” rule in Brownie.

---

## What policy does **not** do

- Parse or judge Telegram message formatting
- Enforce preferred-hold target % (agent guidance for economic exposure incl. LP/lend; execution waives Haystack price-impact on buys into listed ASAs; policy waives `MIN_TVL_USD` for open/increase into opportunities that include those ASAs)
- Gate on `confidence` (schema/reporting field; coerce happens earlier)
- Re-run MCP research
- Validate swap/execution quote economics beyond the structural swap rules above (slippage/impact checks happen at **execution**)

---

## Deterministic `/unwind` (Telegram)

Operator close-all bypasses the LLM portfolio agent. The host planner emits
claim → uncommit → exit actions (plus known LST receipt unstakes) and validates
with a relaxed allocation config (`maxPositionPct`/`maxProtocolPct` 100,
`minLiquidReservePct` 0, `blockIncompleteSnapshot: false`, stale/TVL floors
waived) so intentional flattening is not blocked by concentration soft caps.
Shape/position hard checks still apply. Confirm requires
`ENABLE_TRANSACTION_SIGNING` and an unpaused bot.

---

## Operator reading of Telegram digests

| Digest line | Meaning |
| --- | --- |
| `Policy approved` | No hard violations (or signing disabled) |
| `Policy blocked` | Hard violations present; actions show `not executed · policy blocked` |
| `Policy n/a` | No structured plan (schema/parse path); policy skipped |
| “Risks / policy notes” | Soft warnings and/or blocked violation list |

Run statuses after policy:

- `planned` — policy rejected (or signing off with issues surfaced as warnings depending on path)
- `validated-dry-run` — approved, signing off
- `confirmed` / `partially-executed` / `failed` — signing on after executor outcomes
- `partially-executed` is expected when foundation actions confirm and dependents are deferred to the next review
