import type { AssetPrice, Position, WalletPositions } from "../domain.js";
import { formatUsd, money } from "./money.js";

const USDC_ASSET_ID = 31_566_704;

/** MainNet assets we can fall back to when Canix omits position.assetId. */
const KNOWN_ASSET_IDS_BY_SYMBOL: Record<string, number> = {
  ALGO: 0,
  USDC: USDC_ASSET_ID,
  USDT: 312_769,
  XUSD: 760_037_151,
};

/** Pegged assets priced at $1 when CompX omits a usable USD quote. */
const UNIT_USD_ASSET_IDS = new Set<number>([USDC_ASSET_ID, 312_769]);

function normalizeSymbol(symbol: string | null | undefined): string | null {
  if (!symbol) {
    return null;
  }
  const trimmed = symbol.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

export function knownAssetIdForSymbol(
  symbol: string | null | undefined,
): number | null {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) {
    return null;
  }
  if (KNOWN_ASSET_IDS_BY_SYMBOL[normalized] !== undefined) {
    return KNOWN_ASSET_IDS_BY_SYMBOL[normalized];
  }
  // Folks / receipt tokens often look like fUSDC, aUSDC, etc.
  if (normalized.endsWith("USDC") || normalized.includes("USDC")) {
    return USDC_ASSET_ID;
  }
  if (normalized.endsWith("USDT") || normalized.includes("USDT")) {
    return 312_769;
  }
  if (normalized === "XUSD" || normalized.endsWith("XUSD")) {
    return 760_037_151;
  }
  return null;
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

function isUnitUsdAssetId(assetId: number | null): boolean {
  return assetId !== null && UNIT_USD_ASSET_IDS.has(assetId);
}

function looksLikeUnitUsdPosition(position: Position): boolean {
  if (isUnitUsdAssetId(position.assetId)) {
    return true;
  }
  if (knownAssetIdForSymbol(position.assetSymbol) !== null) {
    const mapped = knownAssetIdForSymbol(position.assetSymbol);
    return isUnitUsdAssetId(mapped);
  }
  // Folks supplied rows are usually stablecoin underlying with a broken oracle.
  const protocol = position.protocol.toLowerCase();
  if (
    protocol.includes("folks") &&
    position.positionType === "supplied" &&
    money(position.amount).gt(0)
  ) {
    return true;
  }
  return false;
}

function usableTokenPrice(priceUsd: string | null | undefined): string | null {
  if (priceUsd === null || priceUsd === undefined) {
    return null;
  }
  try {
    const value = money(priceUsd);
    // CompX sometimes returns 0 for USDC instead of null; treat as missing.
    if (!value.isFinite() || value.lte(0)) {
      return null;
    }
    return priceUsd;
  } catch {
    return null;
  }
}

/** Canix sometimes returns amount > 0 with usdValue ~0 (e.g. Folks at 3e-9). */
export function positionNeedsTokenReprice(position: Position): boolean {
  if (money(position.amount).lte(0)) {
    return false;
  }

  if (looksLikeUnitUsdPosition(position)) {
    // Stablecoin / Folks supply: expect ~$1 per unit. Canix may return a
    // microscopic non-zero usdValue that still formats as $0.00.
    if (position.usdValue === null) {
      return true;
    }
    const impliedPrice = money(position.usdValue).div(money(position.amount));
    return impliedPrice.lt("0.5");
  }

  if (positionPriceAssetCandidates(position).length === 0) {
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
    if (isUnitUsdAssetId(assetId)) {
      return { assetId, priceUsd: "1", source: "unit-usd-peg" };
    }
  }
  if (looksLikeUnitUsdPosition(position)) {
    return {
      assetId:
        knownAssetIdForSymbol(position.assetSymbol) ??
        (isUnitUsdAssetId(position.assetId) ? position.assetId! : USDC_ASSET_ID),
      priceUsd: "1",
      source: "unit-usd-peg",
    };
  }
  return null;
}

/**
 * Fill missing/zero DeFi USD values from CompX token prices × position.amount.
 * USDC/USDT (and Folks supplied stables) default to $1 when CompX has no usable quote.
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
      const usable = usableTokenPrice(price?.priceUsd);
      if (usable !== null) {
        matchedAssetId = assetId;
        priceUsd = usable;
        source = price?.source ?? "compx";
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
