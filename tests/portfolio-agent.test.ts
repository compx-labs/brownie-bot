import { describe, expect, it, vi } from "vitest";

import type { Canix402Client } from "../src/integrations/canix402/client.js";
import type { PortfolioReader } from "../src/integrations/algorand/portfolio.js";
import {
  OpenAiPortfolioAgent,
  type ResponsesClient,
} from "../src/services/portfolio-agent.js";
import { opportunity, portfolioPlan, portfolioSnapshot } from "./fixtures.js";

const managedWallet =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";
const requiredTools = [
  "canix_get_positions",
  "canix_list_opportunities",
  "canix_search_opportunities",
  "canix_get_personalized_opportunities",
  "canix_list_execution_shapes",
  "canix_get_execution_quote",
  "canix_get_quote",
  "canix_optin",
  "canix_swap",
];

function toolSchema(name: string) {
  const propertiesByTool: Record<string, Record<string, unknown>> = {
    canix_get_positions: { address: { type: "string" } },
    canix_get_personalized_opportunities: {
      address: { type: "string" },
    },
    canix_get_execution_quote: {
      shapeKey: { type: "string" },
      input: {
        type: "object",
        properties: {
          userAddress: { type: "string" },
          assetAId: {},
          assetBId: {},
          maxSlippageBps: {},
        },
      },
    },
    canix_get_quote: {
      address: {},
      fromAssetId: {},
      toAssetId: {},
      amount: {},
    },
    canix_optin: { address: {}, quote: {} },
    canix_swap: { address: {}, quote: {}, slippage: {} },
  };
  return {
    type: "object",
    properties: propertiesByTool[name] ?? {},
  };
}

function setup(responses: unknown[]) {
  const create = vi.fn();
  responses.forEach((response) => create.mockResolvedValueOnce(response));
  const callManagedTool = vi.fn().mockResolvedValue({
    data: { data: [opportunity()] },
  });
  const canix = {
    listTools: vi.fn().mockResolvedValue(
      requiredTools.map((name) => ({
        name,
        inputSchema: toolSchema(name),
      })),
    ),
    callManagedTool,
  } as unknown as Canix402Client;
  const reader: PortfolioReader = {
    read: vi.fn().mockResolvedValue({
      snapshot: portfolioSnapshot(),
      payments: [],
    }),
  };
  const openai: ResponsesClient = { responses: { create } };
  return {
    agent: new OpenAiPortfolioAgent(openai, canix, reader, {
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      maxToolCalls: 8,
      walletAddress: managedWallet,
      minimumHoldingHorizonDays: 30,
    }),
    create,
    callManagedTool,
  };
}

describe("OpenAiPortfolioAgent", () => {
  it("researches MCP opportunities before returning a structured plan", async () => {
    const finalPlan = portfolioPlan({
      currentAllocations: [
        {
          key: "liquid",
          protocol: null,
          opportunityId: null,
          assetIds: [31_566_704],
          weightPct: 100,
          expectedApyPct: 0,
        },
      ],
      targetAllocations: [
        {
          key: "liquid",
          protocol: null,
          opportunityId: null,
          assetIds: [31_566_704],
          weightPct: 100,
          expectedApyPct: 0,
        },
      ],
    });
    const { agent, create, callManagedTool } = setup([
      {
        id: "response-1",
        output: [
          {
            type: "function_call",
            call_id: "call-1",
            name: "canix_get_personalized_opportunities",
            arguments: JSON.stringify({ limit: 25 }),
          },
        ],
      },
      {
        id: "response-2",
        output: [],
        output_text: JSON.stringify(finalPlan),
      },
    ]);

    const result = await agent.run();

    expect(result.plan).toEqual(finalPlan);
    expect(result.opportunities).toHaveLength(1);
    expect(result.toolCalls).toContain("canix_get_personalized_opportunities");
    expect(callManagedTool).toHaveBeenCalledWith(
      "canix_get_personalized_opportunities",
      { limit: 25 },
      managedWallet,
    );
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the model skips opportunity research", async () => {
    const { agent } = setup([
      {
        id: "response-1",
        output: [],
        output_text: JSON.stringify(portfolioPlan()),
      },
    ]);

    await expect(agent.run()).rejects.toThrow(
      /without researching opportunities/,
    );
  });

  it("rejects malformed tool arguments", async () => {
    const { agent, callManagedTool } = setup([
      {
        id: "response-1",
        output: [
          {
            type: "function_call",
            call_id: "call-1",
            name: "canix_list_opportunities",
            arguments: "{not-json",
          },
        ],
      },
    ]);

    await expect(agent.run()).rejects.toThrow(/invalid tool arguments/);
    expect(callManagedTool).not.toHaveBeenCalled();
  });
});
