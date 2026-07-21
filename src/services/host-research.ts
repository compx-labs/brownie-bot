import type {
  Opportunity,
  PaymentReceipt,
} from "../domain.js";
import type { Canix402Client } from "../integrations/canix402/client.js";

/** Align with portfolio-agent opportunity tool cap. */
export const HOST_RESEARCH_OPPORTUNITY_LIMIT = 25;

export interface HostResearchOptions {
  walletAddress: string;
  opportunityLimit?: number;
}

export interface HostResearchResult {
  opportunities: Opportunity[];
  toolCalls: string[];
  payments: PaymentReceipt[];
}

/**
 * Prefetch Canix research without protocol favoritism:
 * personalized (wallet-matched) + global high-TVL list.
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
