import {
  walletClaimableResponseSchema,
  type ClaimableRow,
  type ExecutionQuoteRequest,
  type PortfolioAction,
  type WalletClaimable,
} from "../domain.js";

export function normalizeWalletClaimable(raw: unknown): WalletClaimable {
  const parsed = walletClaimableResponseSchema.parse(raw);
  const rows = parsed.data ?? parsed.claims ?? parsed.claimable ?? [];
  const fromRows = rows.flatMap((row) => quoteRequestsFromRow(row));
  const claimAllQuotes =
    parsed.claimAllQuotes && parsed.claimAllQuotes.length > 0
      ? parsed.claimAllQuotes.map(normalizeQuoteRequest)
      : fromRows;
  return {
    rows,
    claimAllQuotes,
    totals: {
      claimableUsd: parsed.totals?.claimableUsd ?? null,
      worthClaimingUsd: parsed.totals?.worthClaimingUsd ?? null,
    },
    meta: {
      address: parsed.meta?.address,
      fetchedAt: parsed.meta?.fetchedAt,
    },
    caveats: parsed.caveats ?? [],
  };
}

export function quoteRequestsFromRow(
  row: ClaimableRow,
): ExecutionQuoteRequest[] {
  if (row.quote?.shapeKey) {
    return [normalizeQuoteRequest(row.quote)];
  }
  if (Array.isArray(row.quotes) && row.quotes.length > 0) {
    return row.quotes
      .filter((quote) => typeof quote.shapeKey === "string" && quote.shapeKey)
      .map(normalizeQuoteRequest);
  }
  if (typeof row.shapeKey === "string" && row.shapeKey.length > 0) {
    return [
      {
        shapeKey: row.shapeKey,
        input:
          row.input && typeof row.input === "object"
            ? { ...row.input }
            : {},
      },
    ];
  }
  return [];
}

export function findClaimableRow(
  action: PortfolioAction,
  claimable: WalletClaimable,
): ClaimableRow | undefined {
  const shapeKey = action.executionShapeKey;
  return claimable.rows.find((row) => {
    if (action.positionId && row.positionId === action.positionId) {
      return true;
    }
    if (
      action.opportunityId &&
      row.opportunityId &&
      row.opportunityId === action.opportunityId
    ) {
      return true;
    }
    if (!shapeKey) {
      return false;
    }
    if (row.shapeKey === shapeKey || row.quote?.shapeKey === shapeKey) {
      return true;
    }
    if (row.claimKey && shapeKey.toLowerCase().includes(row.claimKey.toLowerCase())) {
      return true;
    }
    return row.quotes?.some((quote) => quote.shapeKey === shapeKey) === true;
  });
}

export function quoteRequestsForClaimAction(
  action: PortfolioAction,
  claimable: WalletClaimable | undefined,
): ExecutionQuoteRequest[] {
  if (!claimable) {
    return [];
  }
  const row = findClaimableRow(action, claimable);
  return row ? quoteRequestsFromRow(row) : [];
}

export function selectClaimQuoteRequests(
  actions: PortfolioAction[],
  claimable: WalletClaimable | undefined,
  fallback: (action: PortfolioAction) => ExecutionQuoteRequest[],
): Array<{ actionId: string; quote: ExecutionQuoteRequest }> {
  const planned: Array<{ actionId: string; quote: ExecutionQuoteRequest }> = [];
  for (const action of actions) {
    const fromDesk = quoteRequestsForClaimAction(action, claimable);
    const quotes = fromDesk.length > 0 ? fromDesk : fallback(action);
    for (const quote of quotes) {
      planned.push({ actionId: action.id, quote: normalizeQuoteRequest(quote) });
    }
  }
  return planned;
}

export function compactClaimableForModel(
  claimable: WalletClaimable | undefined,
): unknown {
  if (!claimable) {
    return undefined;
  }
  return {
    totals: claimable.totals,
    caveats: claimable.caveats,
    rows: claimable.rows.map((row) => ({
      claimKey: row.claimKey ?? null,
      positionId: row.positionId ?? null,
      opportunityId: row.opportunityId ?? null,
      protocol: row.protocol ?? null,
      shapeKey: row.shapeKey ?? row.quote?.shapeKey ?? null,
      usdValue: row.usdValue ?? null,
      worthClaiming: row.worthClaiming ?? null,
      estimatedNetworkFeeUsd: row.estimatedNetworkFeeUsd ?? null,
    })),
  };
}

function normalizeQuoteRequest(
  quote: ExecutionQuoteRequest,
): ExecutionQuoteRequest {
  return {
    shapeKey: quote.shapeKey,
    input:
      quote.input && typeof quote.input === "object" ? { ...quote.input } : {},
  };
}
