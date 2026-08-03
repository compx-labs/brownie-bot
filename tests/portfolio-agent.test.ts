import { describe, expect, it, vi } from "vitest";

import type { Canix402Client } from "../src/integrations/canix402/client.js";
import type { PortfolioReader } from "../src/integrations/algorand/portfolio.js";
import { portfolioPlanSchema } from "../src/domain.js";
import {
  OpenAiPortfolioAgent,
  MAX_OPPORTUNITY_TOOL_LIMIT,
  PORTFOLIO_AGENT_PROMPT_LITE,
  buildPortfolioAgentInstructions,
  clampOpportunityToolArgs,
  coercePortfolioPlanValue,
  compactToolResultForModel,
  extractOutputText,
  extractStructuredPlanText,
  finalResponseFromStream,
  normalizeAgentResponse,
  normalizeAgentToolArgs,
  selectAgentTools,
  withStreamTrue,
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

function setup(
  responses: unknown[],
  options?: { signingEnabled?: boolean; aiMode?: "full" | "lite" },
) {
  const create = vi.fn();
  responses.forEach((response) => create.mockResolvedValueOnce(response));
  const callManagedTool = vi.fn().mockResolvedValue({
    data: { data: [opportunity()] },
  });
  const getPersonalizedOpportunities = vi.fn().mockResolvedValue({
    opportunities: [opportunity()],
  });
  const getOpportunities = vi.fn().mockResolvedValue({
    opportunities: [opportunity({ opportunityId: "listed:1" })],
  });
  const canix = {
    listTools: vi.fn().mockResolvedValue(
      requiredTools.map((name) => ({
        name,
        inputSchema: toolSchema(name),
      })),
    ),
    callManagedTool,
    getPersonalizedOpportunities,
    getOpportunities,
  } as unknown as Canix402Client;
  const read = vi.fn().mockResolvedValue({
    snapshot: portfolioSnapshot(),
    payments: [],
  });
  const reader: PortfolioReader = { read };
  const openai: ResponsesClient = { responses: { create } };
  return {
    agent: new OpenAiPortfolioAgent(openai, canix, reader, {
      model: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
      reasoningEffort: "medium",
      aiMode: options?.aiMode ?? "full",
      maxToolCalls: 8,
      walletAddress: managedWallet,
      hostGuidance: {
        maxPositionPct: 35,
        maxProtocolPct: 50,
        minLiquidReservePct: 10,
        minTvlUsd: 100_000,
        maxSourceAgeHours: 24,
        minProjectedNetImprovementUsd: 1,
        preferredHoldAssets: [],
      },
      signingEnabled: options?.signingEnabled ?? false,
    }),
    create,
    callManagedTool,
    getPersonalizedOpportunities,
    getOpportunities,
    canix,
    reader,
    read,
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
            arguments: JSON.stringify({ limit: MAX_OPPORTUNITY_TOOL_LIMIT }),
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
      { limit: MAX_OPPORTUNITY_TOOL_LIMIT },
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
        input: Array<{ type?: string; output?: string }>;
      }
    ).input.find((item) => item.type === "function_call_output")?.output;
    expect(modelToolOutput).toBeDefined();
    const parsedOutput = JSON.parse(modelToolOutput!) as {
      data: Array<{ shapeKeys: string[]; executionShapes?: unknown }>;
      meta: { returnedCount: number };
    };
    expect(parsedOutput.meta.returnedCount).toBe(1);
    expect(parsedOutput.data[0]).not.toHaveProperty("executionShapes");
    expect(parsedOutput.data[0]?.shapeKeys?.length).toBeGreaterThan(0);
  });

  it("lite mode prefetches host research and makes a single decide-only LLM call", async () => {
    const finalPlan = portfolioPlan();
    const {
      agent,
      create,
      callManagedTool,
      getPersonalizedOpportunities,
      getOpportunities,
    } = setup(
      [
        {
          data: {
            id: "response-1",
            output: [],
            output_text: JSON.stringify(finalPlan),
          },
          headers: { "x-zs-inference-amount": "0.012" },
        },
      ],
      { aiMode: "lite" },
    );

    const result = await agent.run();

    expect(result.plan).toEqual(finalPlan);
    expect(result.toolCalls).toEqual([
      "canix_get_positions",
      "canix_get_personalized_opportunities",
      "canix_list_opportunities",
    ]);
    expect(getPersonalizedOpportunities).toHaveBeenCalledWith(
      managedWallet,
      MAX_OPPORTUNITY_TOOL_LIMIT,
    );
    expect(getOpportunities).toHaveBeenCalledWith(MAX_OPPORTUNITY_TOOL_LIMIT);
    expect(callManagedTool).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    const request = create.mock.calls[0]?.[0] as {
      instructions: string;
      tools?: unknown;
      tool_choice?: unknown;
      input: string;
    };
    expect(request.instructions).toBe(PORTFOLIO_AGENT_PROMPT_LITE);
    expect(request.tools).toBeUndefined();
    expect(request.tool_choice).toBeUndefined();
    const input = JSON.parse(request.input) as {
      aiMode: string;
      researchedOpportunities: { data: unknown[] };
    };
    expect(input.aiMode).toBe("lite");
    expect(input.researchedOpportunities.data.length).toBeGreaterThan(0);
    expect(result.inferenceCost).toEqual({
      totalUsdc: "0.012",
      requestCount: 1,
      charges: [
        {
          amountUsdc: "0.012",
          headers: { "x-zs-inference-amount": "0.012" },
        },
      ],
    });
  });

  it("appends operator preferences to lite instructions when provided", async () => {
    const { agent, create } = setup(
      [
        {
          id: "response-1",
          output: [],
          output_text: JSON.stringify(portfolioPlan()),
        },
      ],
      { aiMode: "lite" },
    );

    await agent.run({ operatorPreferences: "Build CompX liquidity." });

    const request = create.mock.calls[0]?.[0] as { instructions: string };
    expect(request.instructions).toBe(
      buildPortfolioAgentInstructions("lite", "Build CompX liquidity."),
    );
    expect(request.instructions).toContain("OPERATOR PREFERENCES");
    expect(request.instructions).toContain("Build CompX liquidity.");
  });

  it("includes priorReview in the task input when provided", async () => {
    const { agent, create } = setup(
      [
        {
          id: "response-1",
          output: [],
          output_text: JSON.stringify(portfolioPlan()),
        },
      ],
      { aiMode: "lite" },
    );

    await agent.run({
      priorReview: {
        id: "prior-1",
        status: "partially-executed",
        completedAt: "2026-07-30T12:00:00.000Z",
        actions: [
          {
            actionId: "reduce-1",
            type: "reduce",
            protocol: "tinyman",
            status: "confirmed",
            transactionId: "TX1",
          },
        ],
      },
    });

    const input = JSON.parse(
      (create.mock.calls[0]?.[0] as { input: string }).input,
    ) as { priorReview?: { id: string; actions: unknown[] } };
    expect(input.priorReview).toEqual({
      id: "prior-1",
      status: "partially-executed",
      completedAt: "2026-07-30T12:00:00.000Z",
      actions: [
        {
          actionId: "reduce-1",
          type: "reduce",
          protocol: "tinyman",
          status: "confirmed",
          transactionId: "TX1",
        },
      ],
    });
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
        input: Array<{ type?: string; output?: string }>;
      }
    ).input.find((item) => item.type === "function_call_output")?.output;
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
      { minTvlUsd: 100_000, maxRows: MAX_OPPORTUNITY_TOOL_LIMIT },
    ) as {
      data: Array<{
        opportunityId: string;
        shapeKeys: string[];
        executionShapes?: unknown;
      }>;
      meta: { sourceCount: number; returnedCount: number; truncated: boolean };
    };

    expect(compacted.meta).toMatchObject({
      sourceCount: 40,
      returnedCount: MAX_OPPORTUNITY_TOOL_LIMIT,
      truncated: true,
    });
    expect(compacted.data).toHaveLength(MAX_OPPORTUNITY_TOOL_LIMIT);
    expect(compacted.data[0]?.opportunityId).toBe("tinyman:pool:0");
    expect(compacted.data[0]).not.toHaveProperty("executionShapes");
    expect(compacted.data[0]?.shapeKeys).toEqual(["shape:0"]);
  });

  it("selects only allowlisted research tools", () => {
    const selected = selectAgentTools(
      requiredTools.map((name) => ({
        name,
        inputSchema: { type: "object", properties: {} },
      })),
    ).map((tool) => tool.name);

    expect(selected).toEqual([
      "canix_list_opportunities",
      "canix_search_opportunities",
      "canix_get_personalized_opportunities",
      "canix_get_protocol_opportunities",
      "canix_list_execution_shapes",
      "canix_get_quote",
    ]);
    expect(
      clampOpportunityToolArgs("canix_list_opportunities", { limit: 200 }),
    ).toEqual({ limit: MAX_OPPORTUNITY_TOOL_LIMIT });
  });

  it("coerces canix_get_quote asset ids from strings to integers", () => {
    expect(
      normalizeAgentToolArgs("canix_get_quote", {
        fromAssetId: "246516580",
        toAssetId: "31566704",
        amount: "200000",
        type: "fixed-input",
      }),
    ).toEqual({
      fromAssetId: 246_516_580,
      toAssetId: 31_566_704,
      amount: "200000",
      type: "fixed-input",
    });
  });

  it("scales liquid balance base units for the model input", async () => {
    const { agent, create, read } = setup([
      {
        id: "response-1",
        output: [
          {
            type: "function_call",
            call_id: "call-1",
            name: "canix_get_personalized_opportunities",
            arguments: JSON.stringify({ limit: MAX_OPPORTUNITY_TOOL_LIMIT }),
          },
        ],
      },
      {
        id: "response-2",
        output: [],
        output_text: JSON.stringify(portfolioPlan()),
      },
    ]);
    read.mockResolvedValueOnce({
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
          amount: "30",
          spendableAmount: "30",
          amountRaw: "30000000",
        }),
        expect.objectContaining({
          assetId: 0,
          amount: "1.5",
          spendableAmount: "0.5",
          amountRaw: "1500000",
        }),
      ]),
    );
    const algo = input.portfolioSnapshot.liquidBalances.find(
      (row) => row.assetId === 0,
    );
    expect(Object.keys(algo ?? {})).toEqual(
      expect.arrayContaining([
        "amount",
        "spendableAmount",
        "usdValue",
        "amountRaw",
      ]),
    );
    // Human fields should appear before amountRaw in the compact payload.
    const keys = Object.keys(algo ?? {});
    expect(keys.indexOf("amount")).toBeLessThan(keys.indexOf("amountRaw"));
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

  it("repairs once when the final plan is markdown instead of JSON", async () => {
    const finalPlan = portfolioPlan();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { agent, create } = setup([
      {
        id: "response-1",
        output: [
          {
            type: "function_call",
            call_id: "call-1",
            name: "canix_list_opportunities",
            arguments: JSON.stringify({ limit: MAX_OPPORTUNITY_TOOL_LIMIT }),
          },
        ],
      },
      {
        id: "response-2",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "# PORTFOLIO PLAN\n\nMarkdown is not JSON.",
              },
            ],
          },
        ],
      },
      {
        id: "response-3",
        output: [],
        output_text: JSON.stringify(finalPlan),
      },
    ]);

    const result = await agent.run();

    expect(result.plan).toEqual(finalPlan);
    expect(create).toHaveBeenCalledTimes(3);
    const repairRequest = create.mock.calls[2]?.[0] as {
      tools: unknown[];
      previous_response_id?: string;
      store?: boolean;
      stream?: boolean;
      input: Array<{ role?: string; content?: string; type?: string }>;
    };
    expect(repairRequest.previous_response_id).toBeUndefined();
    expect(repairRequest.store).toBe(false);
    expect(repairRequest.stream).toBe(true);
    expect(repairRequest.tools).toEqual([]);
    expect(
      repairRequest.input.some(
        (item) =>
          typeof item.content === "string" &&
          item.content.includes("valid portfolio_plan JSON"),
      ),
    ).toBe(true);
    expect(
      repairRequest.input.some((item) => item.type === "function_call"),
    ).toBe(true);
    errorSpy.mockRestore();
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
            arguments: JSON.stringify({
              protocol: "compx",
              limit: MAX_OPPORTUNITY_TOOL_LIMIT,
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
            arguments: JSON.stringify({ limit: MAX_OPPORTUNITY_TOOL_LIMIT }),
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
        input: Array<{ type?: string; call_id?: string; output?: string }>;
      }
    ).input;
    const skippedOutput = secondInput.find(
      (item) => item.type === "function_call_output",
    );
    expect(skippedOutput?.call_id).toBe("call-1");
    expect(skippedOutput?.output).toContain("TOOL_ERROR");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("canix_get_protocol_opportunities"),
    );
    errorSpy.mockRestore();
  });

  it("returns canix_get_quote gateway timeouts to the model and continues", async () => {
    const finalPlan = portfolioPlan();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { agent, create, callManagedTool } = setup([
      {
        id: "response-1",
        output: [
          {
            type: "function_call",
            call_id: "call-list",
            name: "canix_list_opportunities",
            arguments: JSON.stringify({ limit: MAX_OPPORTUNITY_TOOL_LIMIT }),
          },
        ],
      },
      {
        id: "response-2",
        output: [
          {
            type: "function_call",
            call_id: "call-quote",
            name: "canix_get_quote",
            arguments: JSON.stringify({
              fromAssetId: 246_516_580,
              toAssetId: 760_037_151,
              amount: "1000000",
            }),
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
      .mockResolvedValueOnce({ data: { data: [opportunity()] } })
      .mockRejectedValueOnce(
        new Error(
          "Canix402 GATEWAY_CLIENT_ERROR: /swaps/quote: expected 200, got 504 (status=504, body=error code: 504)",
        ),
      );

    const result = await agent.run();

    expect(result.plan).toEqual(finalPlan);
    expect(callManagedTool).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(3);
    const followUpInput = (
      create.mock.calls[2]?.[0] as {
        input: Array<{ type?: string; call_id?: string; output?: string }>;
      }
    ).input;
    const quoteError = followUpInput.find(
      (item) =>
        item.type === "function_call_output" && item.call_id === "call-quote",
    );
    expect(quoteError?.output).toContain("GATEWAY_TIMEOUT");
    expect(quoteError?.output).toContain("246516580");
    expect(quoteError?.output).toMatch(/Retry with a different size/i);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Tool args:"),
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

  it("forces stream: true and drains SSE to response.completed", async () => {
    expect(withStreamTrue({ model: "m", store: false })).toEqual({
      model: "m",
      store: false,
      stream: true,
    });

    const completed = {
      id: "resp-1",
      output: [{ type: "message", content: [] }],
      output_text: "done",
    };
    async function* events() {
      yield { type: "response.created", response: { id: "resp-1" } };
      yield { type: "response.output_text.delta", delta: "do" };
      yield { type: "response.completed", response: completed };
    }

    await expect(finalResponseFromStream(events())).resolves.toEqual(completed);
    await expect(finalResponseFromStream(completed)).resolves.toEqual(completed);
    await expect(
      finalResponseFromStream(
        (async function* () {
          yield {
            type: "response.failed",
            response: { error: { message: "operator down" } },
          };
        })(),
      ),
    ).rejects.toThrow(/operator down/);
  });

  it("extracts JSON objects from markdown fences and prose", () => {
    expect(extractStructuredPlanText('{"summary":"direct"}')).toBe(
      '{"summary":"direct"}',
    );
    expect(
      extractStructuredPlanText(
        'Here you go:\n```json\n{"summary":"fenced"}\n```\n',
      ),
    ).toBe('{"summary":"fenced"}');
    expect(
      extractStructuredPlanText(
        '# Plan\n\n{"summary":"embedded","confidence":0.5}\n',
      ),
    ).toBe('{"summary":"embedded","confidence":0.5}');
  });

  it("coerces common glm-5 portfolio_plan drift into schema-valid JSON", () => {
    const drifted = {
      portfolio_plan: {
        actions: [
          {
            actionId: "open-folks-1",
            type: "open",
            reason: "High TVL supply with ready shape",
            executionShapeKey: "folks.supply",
            authorizedSpends: [
              { fromAssetId: 31_566_704, amountRaw: "1000000" },
            ],
          },
        ],
        noActionPositions: [
          { positionId: "pos-liquid", reason: "Keep reserve" },
        ],
        rejectedCandidates: [{ opportunityId: "opp-x", reason: "TVL too low" }],
        summary: {
          narrative: "Deploy idle USDC into Folks",
          totalProjectedNetBenefitUsd: 12.5,
        },
      },
    };

    const coerced = coercePortfolioPlanValue(drifted);
    const parsed = portfolioPlanSchema.safeParse(coerced);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data.actions[0]?.id).toBe("open-folks-1");
    expect(parsed.data.actions[0]?.rationale).toBe(
      "High TVL supply with ready shape",
    );
    expect(parsed.data.actions[0]?.authorizedSpends[0]).toEqual({
      assetId: 31_566_704,
      amountRaw: "1000000",
    });
    expect(parsed.data.holdDecisions[0]).toContain("pos-liquid");
    expect(parsed.data.projectedNetBenefitUsd).toBe(12.5);
    expect(typeof parsed.data.summary).toBe("string");
    expect(parsed.data.summary).toContain("Deploy idle USDC");
  });

  it("coerces numeric amountRaw fields into digit strings", () => {
    const drifted = {
      currentAllocations: [],
      targetAllocations: [],
      actions: [
        {
          id: "swap-1",
          type: "swap",
          protocol: null,
          opportunityId: null,
          positionId: null,
          amountRaw: 50_000_000,
          fromAssetId: 31_566_704,
          toAssetId: 0,
          targetWeightPct: null,
          executionShapeKey: null,
          executionInput: null,
          authorizedSpends: [{ assetId: 31_566_704, amountRaw: 50_000_000 }],
          rationale: "Swap USDC to ALGO",
          dependencies: [],
        },
        {
          id: "increase-1",
          type: "increase",
          protocol: "reti",
          opportunityId: "reti:validator:1",
          positionId: "reti:1",
          amountRaw: 3_830_300_000,
          fromAssetId: "0",
          toAssetId: null,
          targetWeightPct: "12.5",
          executionShapeKey: "mainnet:reti:stake",
          executionInput: { amount: 3_830_300_000 },
          authorizedSpends: [{ assetId: "0", amountRaw: 3_830_300_000 }],
          rationale: "Stake ALGO",
          dependencies: ["swap-1"],
        },
      ],
      holdDecisions: [],
      projectedNetBenefitUsd: 2,
      summary: "Accumulate COMPX and stake ALGO.",
      confidence: 0.8,
    };

    const coerced = coercePortfolioPlanValue(drifted);
    const parsed = portfolioPlanSchema.safeParse(coerced);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data.actions[0]?.amountRaw).toBe("50000000");
    expect(parsed.data.actions[0]?.authorizedSpends[0]).toEqual({
      assetId: 31_566_704,
      amountRaw: "50000000",
    });
    expect(parsed.data.actions[1]?.amountRaw).toBe("3830300000");
    expect(parsed.data.actions[1]?.fromAssetId).toBe(0);
    expect(parsed.data.actions[1]?.targetWeightPct).toBe(12.5);
    expect(parsed.data.actions[1]?.authorizedSpends[0]).toEqual({
      assetId: 0,
      amountRaw: "3830300000",
    });
  });

  it("coerces numeric strings for confidence and other plan scalars", () => {
    const drifted = {
      currentAllocations: [
        {
          key: "liquid-usdc",
          protocol: null,
          opportunityId: null,
          assetIds: [31_566_704],
          weightPct: "7.2",
          expectedApyPct: "0",
        },
      ],
      targetAllocations: [],
      actions: [],
      holdDecisions: ["Keep reserve"],
      currentAnnualizedReturnPct: "1.93",
      targetAnnualizedReturnPct: "4.18",
      estimatedOneTimeCostsUsd: "0.05",
      projectedNetBenefitUsd: "1.78",
      holdingHorizonDays: "90",
      evidence: [],
      assumptions: [],
      risks: [],
      confidence: "0.7",
      summary: "Deploy idle capital.",
    };

    const coerced = coercePortfolioPlanValue(drifted);
    const parsed = portfolioPlanSchema.safeParse(coerced);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data.confidence).toBe(0.7);
    expect(parsed.data.projectedNetBenefitUsd).toBe(1.78);
    expect(parsed.data.holdingHorizonDays).toBe(90);
    expect(parsed.data.currentAllocations[0]?.weightPct).toBe(7.2);
    expect(parsed.data.currentAnnualizedReturnPct).toBe(1.93);
  });

  it("coerces percent-style confidence strings into 0-1", () => {
    const coerced = coercePortfolioPlanValue({
      currentAllocations: [],
      targetAllocations: [],
      actions: [],
      holdDecisions: [],
      projectedNetBenefitUsd: 0,
      summary: "Hold.",
      confidence: "70%",
    });
    const parsed = portfolioPlanSchema.safeParse(coerced);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data.confidence).toBe(0.7);
  });

  it("coerces allocation label/usdValue drift into key-based allocations", () => {
    const drifted = {
      currentAllocations: [
        {
          label: "Folks Finance xALGO Staking",
          usdValue: 107.8,
          weightPct: 34.6,
        },
        { label: "Liquid USDC", usdValue: 22.54, weightPct: 7.2 },
      ],
      targetAllocations: [
        {
          label: "Haystack HAY Staking",
          usdValue: 38.21,
          weightPct: 12.3,
        },
      ],
      actions: [],
      holdDecisions: ["Keep Folks xALGO"],
      projectedNetBenefitUsd: 1.2,
      summary: "Rotate into HAY staking.",
    };

    const coerced = coercePortfolioPlanValue(drifted);
    const parsed = portfolioPlanSchema.safeParse(coerced);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data.currentAllocations[0]).toMatchObject({
      key: "Folks Finance xALGO Staking",
      protocol: null,
      opportunityId: null,
      assetIds: [],
      weightPct: 34.6,
      expectedApyPct: null,
    });
    expect(parsed.data.targetAllocations[0]?.key).toBe("Haystack HAY Staking");
  });

  it("soft-succeeds with planRawText when repair still cannot parse", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rawReport = "Still not valid portfolio plan JSON after repair.";
    const { agent, create } = setup([
      {
        id: "response-1",
        output: [
          {
            type: "function_call",
            call_id: "call-1",
            name: "canix_list_opportunities",
            arguments: JSON.stringify({ limit: MAX_OPPORTUNITY_TOOL_LIMIT }),
          },
        ],
      },
      {
        id: "response-2",
        output: [],
        output_text: "# PORTFOLIO PLAN\n\nMarkdown is not JSON.",
      },
      {
        id: "response-3",
        output: [],
        output_text: rawReport,
      },
    ]);

    const result = await agent.run();

    expect(result.plan).toBeUndefined();
    expect(result.planRawText).toBe(rawReport);
    expect(result.planParseError).toMatch(/invalid structured plan/);
    expect(result.opportunities).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(3);
    errorSpy.mockRestore();
  });

  it("replays conversation client-side and never sends previous_response_id", async () => {
    const finalPlan = portfolioPlan();
    const { agent, create } = setup([
      {
        id: "response-1",
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
        id: "response-2",
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

    const first = create.mock.calls[0]?.[0] as {
      store?: boolean;
      stream?: boolean;
      previous_response_id?: string;
    };
    expect(first.store).toBe(false);
    expect(first.stream).toBe(true);
    expect(first.previous_response_id).toBeUndefined();

    const followUp = create.mock.calls[1]?.[0] as {
      previous_response_id?: string;
      store?: boolean;
      stream?: boolean;
      input: unknown;
    };
    expect(followUp.previous_response_id).toBeUndefined();
    expect(followUp.store).toBe(false);
    expect(followUp.stream).toBe(true);
    expect(Array.isArray(followUp.input)).toBe(true);
    const input = followUp.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({ role: "user" });
    expect(input.some((item) => item.type === "function_call")).toBe(true);
    expect(input.some((item) => item.type === "function_call_output")).toBe(
      true,
    );
  });

  it("replays conversation when response id is empty", async () => {
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
      store?: boolean;
      stream?: boolean;
      input: unknown;
    };
    expect(followUp.previous_response_id).toBeUndefined();
    expect(followUp.store).toBe(false);
    expect(followUp.stream).toBe(true);
    expect(Array.isArray(followUp.input)).toBe(true);
    const input = followUp.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({ role: "user" });
    expect(input.some((item) => item.type === "function_call")).toBe(true);
    expect(input.some((item) => item.type === "function_call_output")).toBe(
      true,
    );
  });
});
