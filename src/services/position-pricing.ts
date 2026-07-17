import type { AssetPrice, Position, WalletPositions } from "../domain.js";
import { formatUsd, money } from "./money.js";

const USDC_ASSET_ID = 31_566_704;

/** MainNet assets we can fall back to when Canix omits position.assetId. */
const KNOWN_ASSET_IDS_BY_SYMBOL: Record<string, number> = {
  ALGO: 0,
  USDC: USDC_ASSET_ID,
  USDT: 312_769,
  xUSD: 760_037_151,
  XUSD: 760_037_151,
};

/** Pegged assets priced at $1 when CompX omits a USD quote. */
const UNIT_USD_ASSET_IDS = new Set<number>([USDC_ASSET_ID, 312_769]);
const UNIT_USD_SYMBOLS = new Set(["USDC", "USDT"]);

export function knownAssetIdForSymbol(
  symbol: string | null | undefined,
): number | null {
  if (!symbol) {
    return null;
  }
  return (
    KNOWN_ASSET_IDS_BY_SYMBOL[symbol] ??
    KNOWN_ASSET_IDS_BY_SYMBOL[symbol.toUpperCase()] ??
    null
  );
}

/** Candidate IDs to try when pricing (explicit id first, then symbol fallback). */
export function positionPriceAssetCandidates(position: Position): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  const push = (assetId: number | null) => {
    if (assetId === null || seen.has(assetId)) {
      return;
    }
    seen.add(assetId);
    ids.push(assetId);
  };
  push(position.assetId);
  push(knownAssetIdForSymbol(position.assetSymbol));
  return ids;
}

function isUnitUsdPosition(position: Position, assetId: number | null): boolean {
  if (assetId !== null && UNIT_USD_ASSET_IDS.has(assetId)) {
    return true;
  }
  const symbol = position.assetSymbol?.toUpperCase();
  return Boolean(symbol && UNIT_USD_SYMBOLS.has(symbol));
}

/** Canix sometimes returns amount > 0 with usdValue 0/null (e.g. Folks lending). */
export function positionNeedsTokenReprice(position: Position): boolean {
  const canPrice =
    positionPriceAssetCandidates(position).length > 0 ||
    isUnitUsdPosition(position, position.assetId);
  if (!canPrice) {
    return false;
  }
  if (money(position.amount).lte(0)) {
    return false;
  }
  return position.usdValue === null || position.usdValue === 0;
}

export function collectRepriceAssetIds(positions: Position[]): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const position of positions) {
    if (!positionNeedsTokenReprice(position)) {
      continue;
    }
    for (const assetId of positionPriceAssetCandidates(position)) {
      if (seen.has(assetId)) {
        continue;
      }
      seen.add(assetId);
      ids.push(assetId);
    }
  }
  return ids;
}

function resolveUnitUsdPrice(
  position: Position,
  candidates: number[],
): { assetId: number; priceUsd: string; source: string } | null {
  for (const assetId of candidates) {
    if (UNIT_USD_ASSET_IDS.has(assetId)) {
      return { assetId, priceUsd: "1", source: "unit-usd-peg" };
    }
  }
  if (isUnitUsdPosition(position, null)) {
    return {
      assetId: knownAssetIdForSymbol(position.assetSymbol) ?? USDC_ASSET_ID,
      priceUsd: "1",
      source: "unit-usd-peg",
    };
  }
  return null;
}

/**
 * Fill missing/zero DeFi USD values from CompX token prices × position.amount.
 * USDC/USDT default to $1 when CompX has no quote. Unpriced non-stables become null.
 */
export function repricePositionsFromTokenPrices(
  positions: Position[],
  prices: AssetPrice[],
): { positions: Position[]; notes: string[] } {
  const priceByAsset = new Map(
    prices.map((price) => [price.assetId, price] as const),
  );
  const notes: string[] = [];
  const next = positions.map((position) => {
    if (!positionNeedsTokenReprice(position)) {
      return position;
    }
    const candidates = positionPriceAssetCandidates(position);
    let matchedAssetId: number | null = null;
    let priceUsd: string | null = null;
    let source = "compx";

    for (const assetId of candidates) {
      const price = priceByAsset.get(assetId);
      if (price && price.priceUsd !== null) {
        matchedAssetId = assetId;
        priceUsd = price.priceUsd;
        source = price.source;
        break;
      }
    }

    if (priceUsd === null) {
      const peg = resolveUnitUsdPrice(position, candidates);
      if (peg) {
        matchedAssetId = peg.assetId;
        priceUsd = peg.priceUsd;
        source = peg.source;
      }
    }

    if (priceUsd === null || matchedAssetId === null) {
      notes.push(
        `Missing USD price to revalue ${position.protocol} position ${position.positionId} (tried asset ids ${candidates.join(", ") || "none"})`,
      );
      return { ...position, usdValue: null };
    }

    const usdValue = Number(
      formatUsd(money(position.amount).times(money(priceUsd))),
    );
    notes.push(
      `Repriced ${position.protocol} ${position.positionType} ${position.positionId} via ${source} asset ${matchedAssetId} (was ${position.usdValue ?? "null"})`,
    );
    return { ...position, usdValue };
  });
  return { positions: next, notes };
}

export function recomputeWalletPositionTotals(
  positions: Position[],
): WalletPositions["totals"] {
  let supplied = money(0);
  let borrowed = money(0);
  let rewards = money(0);
  let suppliedComplete = true;
  let borrowedComplete = true;
  let rewardsComplete = true;

  for (const position of positions) {
    if (position.usdValue === null) {
      if (position.positionType === "debt") {
        borrowedComplete = false;
      } else if (position.positionType === "reward") {
        rewardsComplete = false;
      } else {
        suppliedComplete = false;
      }
      continue;
    }
    const value = money(position.usdValue);
    if (position.positionType === "debt") {
      borrowed = borrowed.plus(value);
    } else if (position.positionType === "reward") {
      rewards = rewards.plus(value);
    } else {
      supplied = supplied.plus(value);
    }
  }

  const suppliedUsd = suppliedComplete ? Number(formatUsd(supplied)) : null;
  const borrowedUsd = borrowedComplete ? Number(formatUsd(borrowed)) : null;
  const rewardsUsd = rewardsComplete ? Number(formatUsd(rewards)) : null;
  const netUsd =
    suppliedUsd === null || borrowedUsd === null || rewardsUsd === null
      ? null
      : Number(
          formatUsd(
            money(suppliedUsd).minus(money(borrowedUsd)).plus(money(rewardsUsd)),
          ),
        );

  return { suppliedUsd, borrowedUsd, rewardsUsd, netUsd };
}
