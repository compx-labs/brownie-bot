import {
  walletClaimableResponseSchema,
  type ClaimableRow,
  type ExecutionOutcome,
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
          row.input && typeof row.input === "object" ? { ...row.input } : {},
      },
    ];
  }
  return [];
}

export function rowShapeKeys(row: ClaimableRow): string[] {
  const keys: string[] = [];
  if (typeof row.shapeKey === "string" && row.shapeKey.length > 0) {
    keys.push(row.shapeKey);
  }
  if (
    typeof row.quote?.shapeKey === "string" &&
    row.quote.shapeKey.length > 0
  ) {
    keys.push(row.quote.shapeKey);
  }
  for (const quote of row.quotes ?? []) {
    if (typeof quote.shapeKey === "string" && quote.shapeKey.length > 0) {
      keys.push(quote.shapeKey);
    }
  }
  return keys;
}

export function shapeCompatibleWithRow(
  action: PortfolioAction,
  row: ClaimableRow,
): boolean {
  const shapeKey = action.executionShapeKey;
  if (!shapeKey) {
    return false;
  }
  if (rowShapeKeys(row).includes(shapeKey)) {
    return true;
  }
  return row.claimKey === shapeKey;
}

export function findClaimableRow(
  action: PortfolioAction,
  claimable: WalletClaimable,
): ClaimableRow | undefined {
  return findClaimableRows(action, claimable)[0];
}

/**
 * Exact desk matching for a signing path:
 * 1. positionId and compatible shapeKey/claimKey
 * 2. else opportunityId and compatible shapeKey/claimKey
 * 3. else exact shapeKey / quote.shapeKey / claimKey
 *
 * Never substring-match claimKey. When the matched row shares a claimKey
 * (Haystack USDC+HAY, Pact multi-ASA), return every row with that key so the
 * compile unit is complete.
 */
export function findClaimableRows(
  action: PortfolioAction,
  claimable: WalletClaimable,
): ClaimableRow[] {
  const matched = matchExactClaimableRow(action, claimable.rows);
  if (!matched) {
    return [];
  }
  if (matched.claimKey) {
    const shared = claimable.rows.filter(
      (row) => row.claimKey === matched.claimKey,
    );
    if (shared.length > 0) {
      return shared;
    }
  }
  return [matched];
}

function matchExactClaimableRow(
  action: PortfolioAction,
  rows: ClaimableRow[],
): ClaimableRow | undefined {
  if (action.positionId) {
    const byPosition = rows.filter(
      (row) =>
        row.positionId === action.positionId &&
        shapeCompatibleWithRow(action, row),
    );
    if (byPosition.length > 0) {
      return byPosition[0];
    }
  }
  if (action.opportunityId) {
    const byOpportunity = rows.filter(
      (row) =>
        row.opportunityId === action.opportunityId &&
        shapeCompatibleWithRow(action, row),
    );
    if (byOpportunity.length > 0) {
      return byOpportunity[0];
    }
  }
  if (action.executionShapeKey) {
    return rows.find((row) => shapeCompatibleWithRow(action, row));
  }
  return undefined;
}

export function quoteRequestsForClaimAction(
  action: PortfolioAction,
  claimable: WalletClaimable | undefined,
): ExecutionQuoteRequest[] {
  if (!claimable) {
    return [];
  }
  const unique = new Map<string, ExecutionQuoteRequest>();
  for (const row of findClaimableRows(action, claimable)) {
    for (const quote of quoteRequestsFromRow(row)) {
      const fingerprint = quoteFingerprint(quote);
      if (!unique.has(fingerprint)) {
        unique.set(fingerprint, quote);
      }
    }
  }
  return [...unique.values()];
}

export function actionHasDeskClaimQuote(
  action: PortfolioAction,
  claimable: WalletClaimable | undefined,
): boolean {
  return quoteRequestsForClaimAction(action, claimable).length > 0;
}

export interface PlannedClaimQuote {
  actionId: string;
  quote: ExecutionQuoteRequest;
}

export interface ClaimQuotePlan {
  planned: PlannedClaimQuote[];
  skipped: ExecutionOutcome[];
  unmatchedIds: string[];
}

/**
 * Desk-only claim compile plan. Duplicate claimKey / identical quotes are
 * skipped (first action wins). Unmatched actions are omitted so callers can
 * send them through executeAction.
 */
export function planClaimQuoteRequests(
  actions: PortfolioAction[],
  claimable: WalletClaimable | undefined,
): ClaimQuotePlan {
  const planned: PlannedClaimQuote[] = [];
  const skipped: ExecutionOutcome[] = [];
  const unmatchedIds: string[] = [];
  const seenClaimKeys = new Set<string>();
  const seenFingerprints = new Set<string>();

  for (const action of actions) {
    const rows = claimable ? findClaimableRows(action, claimable) : [];
    const quotes = quoteRequestsForClaimAction(action, claimable);
    if (rows.length === 0 || quotes.length === 0) {
      unmatchedIds.push(action.id);
      continue;
    }
    const claimKey = rows[0]?.claimKey;
    if (claimKey && seenClaimKeys.has(claimKey)) {
      skipped.push({
        actionId: action.id,
        status: "skipped",
        error: `Duplicate claimKey ${claimKey} already queued`,
      });
      continue;
    }
    const novel = quotes.filter(
      (quote) => !seenFingerprints.has(quoteFingerprint(quote)),
    );
    if (novel.length === 0) {
      skipped.push({
        actionId: action.id,
        status: "skipped",
        error: "Duplicate claim quote already queued",
      });
      continue;
    }
    if (claimKey) {
      seenClaimKeys.add(claimKey);
    }
    for (const quote of novel) {
      seenFingerprints.add(quoteFingerprint(quote));
      planned.push({
        actionId: action.id,
        quote: normalizeQuoteRequest(quote),
      });
    }
  }

  return { planned, skipped, unmatchedIds };
}

export function selectClaimQuoteRequests(
  actions: PortfolioAction[],
  claimable: WalletClaimable | undefined,
  fallback: (action: PortfolioAction) => ExecutionQuoteRequest[],
): PlannedClaimQuote[] {
  const plan = planClaimQuoteRequests(actions, claimable);
  const handled = new Set([
    ...plan.planned.map((item) => item.actionId),
    ...plan.skipped.map((item) => item.actionId),
  ]);
  const planned = [...plan.planned];
  for (const action of actions) {
    if (handled.has(action.id)) {
      continue;
    }
    for (const quote of fallback(action)) {
      planned.push({
        actionId: action.id,
        quote: normalizeQuoteRequest(quote),
      });
    }
  }
  return planned;
}

/**
 * Pair compiled quotes with requests by shapeKey. Original array index is
 * only a tie-break when several responses share the same key.
 */
export function alignQuotesByShapeKey<T extends { shapeKey: string }>(
  requests: PlannedClaimQuote[],
  responses: T[],
): Array<{ actionId: string; quote: T }> {
  if (responses.length !== requests.length) {
    throw new Error(
      `Execution quote count mismatch: requested ${requests.length}, received ${responses.length}`,
    );
  }
  const remaining = responses.map((quote, index) => ({ quote, index }));
  return requests.map((request, requestIndex) => {
    const candidates = remaining.filter(
      (item) => item.quote.shapeKey === request.quote.shapeKey,
    );
    if (candidates.length === 0) {
      throw new Error(
        `No compiled quote for shapeKey ${request.quote.shapeKey} (action ${request.actionId})`,
      );
    }
    const chosen =
      candidates.find((item) => item.index === requestIndex) ?? candidates[0]!;
    remaining.splice(remaining.indexOf(chosen), 1);
    return { actionId: request.actionId, quote: chosen.quote };
  });
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

function quoteFingerprint(quote: ExecutionQuoteRequest): string {
  return `${quote.shapeKey}\n${JSON.stringify(quote.input ?? {})}`;
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
