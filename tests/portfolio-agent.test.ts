import { describe, expect, it, vi } from "vitest";

import type { Canix402Client } from "../src/integrations/canix402/client.js";
import type { PortfolioReader } from "../src/integrations/algorand/portfolio.js";
import {
  OpenAiPortfolioAgent,
  MAX_OPPORTUNITY_TOOL_LIMIT,
  clampOpportunityToolArgs,
  compactToolResultForModel,
  extractOutputText,
  normalizeAgentResponse,
  selectAgentTools,
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
  "canix_get_protocol_opportunities",
  "canix_list_execution_shapes",
  "canix_get_execution_quote",
  "canix_get_quote",
  "canix_optin",
  "canix_swap",
  "canix_get_openapi",
  "canix_list_strategies",
];

function toolSchema(name: string) {
  const propertiesByTool: Record<string, Record<string, unknown>> = {
    canix_get_positions: { address: { type: "string" } },
    canix_get_personalized_opportunities: {
      address: { type: "string" },
    },
    canix_get_execution_quote: {
      quotes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            shapeKey: { type: "string" },
            input: {
              type: "object",
              properties: {
                userAddress: { type: "string" },
              },
            },
          },
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

function setup(responses: unknown[], options?: { signingEnabled?: boolean }) {
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
      model: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
      reasoningEffort: "medium",
      maxToolCalls: 8,
      walletAddress: managedWallet,
      hostGuidance: {
        maxPositionPct: 35,
        maxProtocolPct: 50,
        minLiquidReservePct: 10,
        minTvlUsd: 100_000,
        maxSourceAgeHours: 24,
        minProjectedNetImprovementUsd: 1,
      },
      signingEnabled: options?.signingEnabled ?? false,
    }),
    create,
    callManagedTool,
    reader,
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
    const toolNames = (
      create.mock.calls[0]?.[0] as { tools: Array<{ name: string }> }
    ).tools.map((tool) => tool.name);
    expect(toolNames).not.toContain("canix_get_execution_quote");
    expect(toolNames).not.toContain("canix_optin");
    expect(toolNames).not.toContain("canix_swap");
    expect(toolNames).not.toContain("canix_get_openapi");
    expect(toolNames).not.toContain("canix_list_strategies");
    expect(toolNames).not.toContain("canix_get_positions");
    const modelToolOutput = (
      create.mock.calls[1]?.[0] as {
        input: Array<{ output?: string }>;
      }
    ).input[0]?.output;
    expect(modelToolOutput).toBeDefined();
    const parsedOutput = JSON.parse(modelToolOutput!) as {
      data: Array<{ executionShapes: Array<Record<string, unknown>> }>;
      meta: { returnedCount: number };
    };
    expect(parsedOutput.meta.returnedCount).toBe(1);
    expect(parsedOutput.data[0]?.executionShapes[0]).not.toHaveProperty(
      "title",
    );
    expect(parsedOutput.data[0]?.executionShapes[0]).toHaveProperty("shapeKey");
  });

  it("does not expose or invoke final execution tools even when signing is enabled", async () => {
    const { agent, create, callManagedTool } = setup(
      [
        {
          id: "response-1",
          output: [
            {
              type: "function_call",
              call_id: "call-1",
              name: "canix_get_execution_quote",
              arguments: JSON.stringify({
                quotes: [
                  {
                    shapeKey: "mainnet:folks:v2:deposit:escrow",
                    input: { assetAmount: "1" },
                  },
                ],
              }),
            },
          ],
        },
        {
          id: "response-2",
          output: [
            {
              type: "function_call",
              call_id: "call-2",
              name: "canix_list_opportunities",
              arguments: JSON.stringify({ limit: 10 }),
            },
          ],
        },
        {
          id: "response-3",
          output: [],
          output_text: JSON.stringify(portfolioPlan()),
        },
      ],
      { signingEnabled: true },
    );

    await agent.run();

    const toolNames = (
      create.mock.calls[0]?.[0] as { tools: Array<{ name: string }> }
    ).tools.map((tool) => tool.name);
    expect(toolNames).not.toContain("canix_get_execution_quote");
    expect(toolNames).not.toContain("canix_optin");
    expect(toolNames).not.toContain("canix_swap");

    const firstOutput = (
      create.mock.calls[1]?.[0] as {
        input: Array<{ output?: string }>;
      }
    ).input[0]?.output;
    expect(firstOutput).toContain("EXECUTION_HOST_ONLY");
    expect(callManagedTool).toHaveBeenCalledTimes(1);
    expect(callManagedTool).toHaveBeenCalledWith(
      "canix_list_opportunities",
      { limit: 10 },
      managedWallet,
    );
  });

  it("clamps oversized opportunity limits before calling MCP", async () => {
    const { agent, callManagedTool, create } = setup([
      {
        id: "response-1",
        output: [
          {
            type: "function_call",
            call_id: "call-1",
            name: "canix_search_opportunities",
            arguments: JSON.stringify({ limit: 200, sort: "tvl" }),
          },
        ],
      },
      {
        id: "response-2",
        output: [],
        output_text: JSON.stringify(portfolioPlan()),
      },
    ]);

    await agent.run();

    expect(callManagedTool).toHaveBeenCalledWith(
      "canix_search_opportunities",
      { limit: MAX_OPPORTUNITY_TOOL_LIMIT, sort: "tvl" },
      managedWallet,
    );
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("compacts large opportunity payloads for the model while keeping host copies", () => {
    const bulky = Array.from({ length: 40 }, (_, index) =>
      opportunity({
        opportunityId: `tinyman:pool:${index}`,
        tvlUsd: 1_000_000 - index * 1_000,
        executionReady: index < 30,
        executionShapes: [
          {
            shapeKey: `shape:${index}`,
            protocol: "tinyman",
            protocolVersion: "v2",
            action: "addLiquidity",
            variant: "flexible",
            title: "Very long title that should not reach the model",
            summary: "Very long summary that should not reach the model",
            order: 0,
            requiredInputs: ["assetAAmount"],
            requiredAssetIds: [0],
            inputHints: { assetAId: 0 },
          },
        ],
      }),
    );
    const compacted = compactToolResultForModel(
      "canix_list_opportunities",
      { data: bulky },
      { minTvlUsd: 100_000, maxRows: 10 },
    ) as {
      data: Array<{ opportunityId: string; executionShapes: unknown[] }>;
      meta: { sourceCount: number; returnedCount: number; truncated: boolean };
    };

    expect(compacted.meta).toMatchObject({
      sourceCount: 40,
      returnedCount: 10,
      truncated: true,
    });
    expect(compacted.data).toHaveLength(10);
    expect(compacted.data[0]?.opportunityId).toBe("tinyman:pool:0");
    expect(compacted.data[0]?.executionShapes[0]).toEqual({
      shapeKey: "shape:0",
      action: "addLiquidity",
      order: 0,
      requiredInputs: ["assetAAmount"],
      requiredAssetIds: [0],
      inputHints: { assetAId: 0 },
    });
  });

  it("selects only allowlisted research tools", () => {
    const selected = selectAgentTools(
      requiredTools.map((name) => ({
        name,
        inputSchema: { type: "object", properties: {} },
      })),
      false,
    ).map((tool) => tool.name);

    expect(selected).toEqual([
      "canix_list_opportunities",
      "canix_search_opportunities",
      "canix_get_personalized_opportunities",
      "canix_get_protocol_opportunities",
      "canix_list_execution_shapes",
      "canix_get_quote",
    ]);
    expect(clampOpportunityToolArgs("canix_list_opportunities", { limit: 200 }))
      .toEqual({ limit: MAX_OPPORTUNITY_TOOL_LIMIT });
  });

  it("scales liquid balance base units for the model input", async () => {
    const { agent, create, reader } = setup([
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
        output_text: JSON.stringify(portfolioPlan()),
      },
    ]);
    vi.mocked(reader.read).mockResolvedValueOnce({
      snapshot: portfolioSnapshot({
        liquidBalances: [
          {
            assetId: 0,
            amountRaw: "1500000",
            spendableAmountRaw: "500000",
            decimals: 6,
            symbol: "ALGO",
          },
          {
            assetId: 31_566_704,
            amountRaw: "30000000",
            spendableAmountRaw: "30000000",
            decimals: 6,
            symbol: "USDC",
          },
        ],
      }),
      payments: [],
    });

    await agent.run();

    const input = JSON.parse(
      (create.mock.calls[0]?.[0] as { input: string }).input,
    ) as {
      portfolioSnapshot: {
        liquidBalances: Array<{
          assetId: number;
          amountRaw: string;
          amount?: string;
          spendableAmount?: string;
        }>;
      };
    };
    expect(input.portfolioSnapshot.liquidBalances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assetId: 31_566_704,
          amountRaw: "30000000",
          amount: "30",
          spendableAmount: "30",
        }),
        expect.objectContaining({
          assetId: 0,
          amountRaw: "1500000",
          amount: "1.5",
          spendableAmount: "0.5",
        }),
      ]),
    );
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

  it("skips failed protocol opportunity research and continues", async () => {
    const finalPlan = portfolioPlan();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { agent, create, callManagedTool } = setup([
      {
        id: "response-1",
        output: [
          {
            type: "function_call",
            call_id: "call-1",
            name: "canix_get_protocol_opportunities",
            arguments: JSON.stringify({ protocol: "compx", limit: 25 }),
          },
        ],
      },
      {
        id: "response-2",
        output: [
          {
            type: "function_call",
            call_id: "call-2",
            name: "canix_list_opportunities",
            arguments: JSON.stringify({ limit: 25 }),
          },
        ],
      },
      {
        id: "response-3",
        output: [],
        output_text: JSON.stringify(finalPlan),
      },
    ]);
    callManagedTool
      .mockRejectedValueOnce(
        new Error(
          "Canix402 GATEWAY_CLIENT_ERROR: /protocols/compx/opportunities: expected 200 or 402, got 500",
        ),
      )
      .mockResolvedValueOnce({ data: { data: [opportunity()] } });

    const result = await agent.run();

    expect(result.plan).toEqual(finalPlan);
    expect(callManagedTool).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(3);
    const secondInput = (
      create.mock.calls[1]?.[0] as {
        input: Array<{ call_id?: string; output?: string }>;
      }
    ).input;
    expect(secondInput[0]?.call_id).toBe("call-1");
    expect(secondInput[0]?.output).toContain("TOOL_UNAVAILABLE");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("canix_get_protocol_opportunities"),
    );
    errorSpy.mockRestore();
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

  it("normalizes ZeroSignal responses with empty id and message output_text", () => {
    const normalized = normalizeAgentResponse({
      id: "",
      model: "glm-4.7-flash",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: '{"rationale":"ok"}' }],
        },
      ],
    });
    expect(normalized.id).toBeUndefined();
    expect(normalized.output_text).toBe('{"rationale":"ok"}');
    expect(
      extractOutputText([
        {
          type: "message",
          content: [{ type: "output_text", text: "hello" }],
        },
      ]),
    ).toBe("hello");
  });

  it("continues tool loops without previous_response_id when id is empty", async () => {
    const finalPlan = portfolioPlan();
    const { agent, create } = setup([
      {
        id: "",
        output: [
          {
            type: "function_call",
            call_id: "call-1",
            name: "canix_get_personalized_opportunities",
            arguments: JSON.stringify({ limit: 10 }),
          },
        ],
      },
      {
        id: "",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: JSON.stringify(finalPlan),
              },
            ],
          },
        ],
      },
    ]);

    const result = await agent.run();
    expect(result.plan).toEqual(finalPlan);
    expect(create).toHaveBeenCalledTimes(2);
    const followUp = create.mock.calls[1]?.[0] as {
      previous_response_id?: string;
      input: unknown;
    };
    expect(followUp.previous_response_id).toBeUndefined();
    expect(Array.isArray(followUp.input)).toBe(true);
    const input = followUp.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({ role: "user" });
    expect(input.some((item) => item.type === "function_call")).toBe(true);
    expect(input.some((item) => item.type === "function_call_output")).toBe(
      true,
    );
  });
});
