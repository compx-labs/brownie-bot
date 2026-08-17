import { describe, expect, it, vi } from "vitest";

import type { Canix402Client } from "../src/integrations/canix402/client.js";
import {
  COMPX_ASSET_ID,
  TINYMAN_COMPX_ALGO_LP_OPPORTUNITY_ID,
  enrichOpportunitiesWithPreferredHolds,
  preferredOpportunityIds,
  prefetchHostResearch,
} from "../src/services/host-research.js";
import { opportunity } from "./fixtures.js";

describe("preferred-hold host research", () => {
  it("searches each preferred ASA and Tinyman COMPX/ALGO when CompX is preferred", async () => {
    const compxLp = opportunity({
      opportunityId: TINYMAN_COMPX_ALGO_LP_OPPORTUNITY_ID,
      assetPair: "COMPX/ALGO",
      assetIds: [COMPX_ASSET_ID, 0],
      tvlUsd: 50,
    });
    const searchOpportunities = vi
      .fn()
      .mockResolvedValueOnce({ opportunities: [compxLp] })
      .mockResolvedValueOnce({ opportunities: [compxLp] });
    const canix = { searchOpportunities } as unknown as Canix402Client;

    const result = await enrichOpportunitiesWithPreferredHolds(
      canix,
      "ADDR",
      [COMPX_ASSET_ID],
      10,
    );

    expect(searchOpportunities).toHaveBeenNthCalledWith(1, "ADDR", {
      assetIds: [COMPX_ASSET_ID],
      limit: 10,
      includeInactive: false,
    });
    expect(searchOpportunities).toHaveBeenNthCalledWith(2, "ADDR", {
      platform: "tinyman",
      assetIds: [COMPX_ASSET_ID],
      limit: 10,
      includeInactive: false,
    });
    expect(result.toolCalls).toEqual([
      "canix_search_opportunities",
      "canix_search_opportunities",
    ]);
    expect(result.opportunities.map((item) => item.opportunityId)).toEqual([
      TINYMAN_COMPX_ALGO_LP_OPPORTUNITY_ID,
    ]);
    expect(
      preferredOpportunityIds(result.opportunities, [COMPX_ASSET_ID]),
    ).toContain(TINYMAN_COMPX_ALGO_LP_OPPORTUNITY_ID);
  });

  it("skips preferred search when no preferred holds are configured", async () => {
    const searchOpportunities = vi.fn();
    const result = await enrichOpportunitiesWithPreferredHolds(
      { searchOpportunities } as unknown as Canix402Client,
      "ADDR",
      [],
    );
    expect(searchOpportunities).not.toHaveBeenCalled();
    expect(result.opportunities).toEqual([]);
  });

  it("prefetches preferred holds after personalized + list", async () => {
    const listed = opportunity({ opportunityId: "listed:1", tvlUsd: 1_000_000 });
    const compxLp = opportunity({
      opportunityId: TINYMAN_COMPX_ALGO_LP_OPPORTUNITY_ID,
      assetIds: [COMPX_ASSET_ID, 0],
      tvlUsd: 40,
    });
    const canix = {
      getPersonalizedOpportunities: vi.fn().mockResolvedValue({
        opportunities: [listed],
      }),
      getOpportunities: vi.fn().mockResolvedValue({
        opportunities: [listed],
      }),
      searchOpportunities: vi.fn().mockResolvedValue({
        opportunities: [compxLp],
      }),
    } as unknown as Canix402Client;

    const result = await prefetchHostResearch(canix, {
      walletAddress: "ADDR",
      preferredHoldAssetIds: [COMPX_ASSET_ID],
    });

    expect(result.opportunities.map((item) => item.opportunityId)).toEqual([
      "listed:1",
      TINYMAN_COMPX_ALGO_LP_OPPORTUNITY_ID,
    ]);
    expect(result.toolCalls).toContain("canix_search_opportunities");
  });
});
