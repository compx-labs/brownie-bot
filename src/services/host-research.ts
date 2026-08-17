import type {
  Opportunity,
  PaymentReceipt,
  PortfolioSnapshot,
} from "../domain.js";
import type { Canix402Client } from "../integrations/canix402/client.js";

/** Align with portfolio-agent opportunity tool cap. */
export const HOST_RESEARCH_OPPORTUNITY_LIMIT = 10;

export const COMPX_ASSET_ID = 1_732_165_149;
export const TINYMAN_COMPX_ALGO_LP_OPPORTUNITY_ID =
  "ZKAP7DLHJ25VTHPD3W73FGDM7VGU3DJAXL7GNUFW5CG4MIMY72EZ5GFIAI:lp";

const HELD_PROTOCOL_PAGE_SIZE = 100;
const HELD_PROTOCOL_MAX_PAGES = 10;

export interface HostResearchOptions {
  walletAddress: string;
  opportunityLimit?: number;
  /**
   * Existing positions whose opportunityIds must be resolvable for increase/
   * manage plans. Top-N personalized/list catalogs often omit these.
   */
  snapshot?: PortfolioSnapshot;
  /** Preferred-hold ASA ids — host searches by asset so thin LP/lend rows appear. */
  preferredHoldAssetIds?: number[];
}

export interface HostResearchResult {
  opportunities: Opportunity[];
  toolCalls: string[];
  payments: PaymentReceipt[];
}

/**
 * Prefetch Canix research without protocol favoritism:
 * personalized (wallet-matched) + global high-TVL list, then pin any
 * opportunityIds already held in the portfolio snapshot.
 */
export async function prefetchHostResearch(
  canix: Canix402Client,
  options: HostResearchOptions,
): Promise<HostResearchResult> {
  const limit = options.opportunityLimit ?? HOST_RESEARCH_OPPORTUNITY_LIMIT;
  const opportunities: Opportunity[] = [];
  const toolCalls: string[] = [];
  const payments: PaymentReceipt[] = [];

  const personalized = await canix.getPersonalizedOpportunities(
    options.walletAddress,
    limit,
  );
  toolCalls.push("canix_get_personalized_opportunities");
  if (personalized.payment) {
    payments.push(personalized.payment);
  }
  mergeOpportunities(opportunities, personalized.opportunities);

  const listed = await canix.getOpportunities(limit);
  toolCalls.push("canix_list_opportunities");
  if (listed.payment) {
    payments.push(listed.payment);
  }
  mergeOpportunities(opportunities, listed.opportunities);

  const preferred = await enrichOpportunitiesWithPreferredHolds(
    canix,
    options.walletAddress,
    options.preferredHoldAssetIds ?? [],
    limit,
  );
  toolCalls.push(...preferred.toolCalls);
  payments.push(...preferred.payments);
  mergeOpportunities(opportunities, preferred.opportunities);

  if (options.snapshot) {
    const held = await enrichOpportunitiesWithHeldPositions(
      canix,
      options.walletAddress,
      options.snapshot,
      opportunities,
    );
    toolCalls.push(...held.toolCalls);
    payments.push(...held.payments);
    mergeOpportunities(opportunities, held.opportunities);
  }

  if (opportunities.length === 0) {
    throw new Error(
      "Host research returned no opportunities (personalized + list)",
    );
  }

  return {
    opportunities,
    toolCalls,
    payments,
  };
}

/**
 * Opportunity ids currently held in the snapshot (for model pinning / policy).
 */
export function heldOpportunityIdsFromSnapshot(
  snapshot: PortfolioSnapshot,
): string[] {
  const ids = new Set<string>();
  for (const position of snapshot.positions) {
    if (position.opportunityId) {
      ids.add(position.opportunityId);
    }
  }
  return [...ids];
}

/**
 * Search preferred-hold ASAs (and Tinyman COMPX/ALGO when CompX is preferred)
 * so thin LP/lend rows are not omitted from APY/TVL top-N catalogs.
 */
export async function enrichOpportunitiesWithPreferredHolds(
  canix: Canix402Client,
  walletAddress: string,
  preferredHoldAssetIds: number[],
  limit = HOST_RESEARCH_OPPORTUNITY_LIMIT,
): Promise<HostResearchResult> {
  if (preferredHoldAssetIds.length === 0) {
    return { opportunities: [], toolCalls: [], payments: [] };
  }

  const opportunities: Opportunity[] = [];
  const toolCalls: string[] = [];
  const payments: PaymentReceipt[] = [];
  const searches: Array<{ assetIds: number[]; platform?: string }> = [
    ...preferredHoldAssetIds.map((assetId) => ({ assetIds: [assetId] })),
  ];
  if (preferredHoldAssetIds.includes(COMPX_ASSET_ID)) {
    searches.push({ platform: "tinyman", assetIds: [COMPX_ASSET_ID] });
  }

  for (const search of searches) {
    try {
      const result = await canix.searchOpportunities(walletAddress, {
        ...search,
        limit,
        includeInactive: false,
      });
      toolCalls.push("canix_search_opportunities");
      if (result.payment) {
        payments.push(result.payment);
      }
      mergeOpportunities(opportunities, result.opportunities);
    } catch (error) {
      console.error(
        `[host-research] Preferred-hold search failed (${search.platform ?? "any"} assetIds=${search.assetIds.join(",")}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return { opportunities, toolCalls, payments };
}

export function preferredOpportunityIds(
  opportunities: Opportunity[],
  preferredHoldAssetIds: number[],
): string[] {
  const preferred = new Set(preferredHoldAssetIds);
  const ids = new Set<string>();
  for (const opportunity of opportunities) {
    const assetIds = opportunity.assetIds ?? [];
    if (
      opportunity.opportunityId === TINYMAN_COMPX_ALGO_LP_OPPORTUNITY_ID ||
      assetIds.some((assetId) => preferred.has(assetId))
    ) {
      ids.add(opportunity.opportunityId);
    }
  }
  if (
    preferred.has(COMPX_ASSET_ID) &&
    opportunities.some(
      (item) => item.opportunityId === TINYMAN_COMPX_ALGO_LP_OPPORTUNITY_ID,
    )
  ) {
    ids.add(TINYMAN_COMPX_ALGO_LP_OPPORTUNITY_ID);
  }
  return [...ids];
}

/**
 * Fetch protocol catalog rows for snapshot positions whose opportunityIds are
 * missing from the already-researched set (Réti validators often miss top-N).
 */
export async function enrichOpportunitiesWithHeldPositions(
  canix: Canix402Client,
  walletAddress: string,
  snapshot: PortfolioSnapshot,
  alreadyHave: Opportunity[],
): Promise<HostResearchResult> {
  const known = new Set(alreadyHave.map((item) => item.opportunityId));
  const missingByProtocol = new Map<string, Set<string>>();
  for (const position of snapshot.positions) {
    if (!position.opportunityId || known.has(position.opportunityId)) {
      continue;
    }
    const protocol = position.protocol.trim().toLowerCase();
    if (!protocol) {
      continue;
    }
    const bucket = missingByProtocol.get(protocol) ?? new Set<string>();
    bucket.add(position.opportunityId);
    missingByProtocol.set(protocol, bucket);
  }
  if (missingByProtocol.size === 0) {
    return { opportunities: [], toolCalls: [], payments: [] };
  }

  const opportunities: Opportunity[] = [];
  const toolCalls: string[] = [];
  const payments: PaymentReceipt[] = [];

  for (const [protocol, wanted] of missingByProtocol) {
    let offset = 0;
    for (let page = 0; page < HELD_PROTOCOL_MAX_PAGES && wanted.size > 0; page++) {
      const result = await canix.callManagedTool(
        "canix_get_protocol_opportunities",
        {
          protocol,
          limit: HELD_PROTOCOL_PAGE_SIZE,
          offset,
          includeInactive: false,
        },
        walletAddress,
      );
      toolCalls.push("canix_get_protocol_opportunities");
      if (result.payment) {
        payments.push(result.payment);
      }
      const payload = result.data as { data?: Opportunity[] };
      const pageRows = Array.isArray(payload.data) ? payload.data : [];
      for (const item of pageRows) {
        if (wanted.has(item.opportunityId)) {
          opportunities.push(item);
          wanted.delete(item.opportunityId);
        }
      }
      if (pageRows.length < HELD_PROTOCOL_PAGE_SIZE) {
        break;
      }
      offset += pageRows.length;
    }
  }

  return { opportunities, toolCalls, payments };
}

function mergeOpportunities(
  target: Opportunity[],
  incoming: Opportunity[],
): void {
  for (const item of incoming) {
    if (
      !target.some(
        (candidate) =>
          candidate.opportunityId === item.opportunityId &&
          candidate.protocol === item.protocol,
      )
    ) {
      target.push(item);
    }
  }
}
