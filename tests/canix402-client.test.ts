import { describe, expect, it, vi } from "vitest";

import {
  Canix402Client,
  type ToolCaller,
} from "../src/integrations/canix402/client.js";
import type { PaymentBuilder } from "../src/integrations/canix402/payment.js";
import { opportunity } from "./fixtures.js";

function toolResult(payload: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

describe("Canix402Client", () => {
  it("performs preflight, signs, and retries unchanged arguments", async () => {
    const paymentRequired = {
      x402Version: 2,
      resource: {
        url: "https://canix402-api.compx.io/opportunities/personalized?address=ADDRESS&limit=10&includeInactive=false",
      },
      accepts: [],
    };
    const callTool = vi
      .fn<ToolCaller["callTool"]>()
      .mockResolvedValueOnce(
        toolResult({
          error: "PAYMENT_REQUIRED",
          mcpPayment: {
            paymentRequired,
            paymentRequiredHeader: "header",
          },
          request: { method: "GET" },
        }),
      )
      .mockResolvedValueOnce(
        toolResult({
          data: [opportunity()],
          mcpPayment: { paymentResponseHeader: "settlement" },
        }),
      );
    const caller: ToolCaller = {
      callTool,
      close: vi.fn().mockResolvedValue(undefined),
    };
    const buildPayment = vi.fn().mockResolvedValue({
      paymentSignature: "signed-payment",
      receipt: {
        amountBaseUnits: "50000",
        assetId: "31566704",
        network: "algorand:mainnet",
      },
    });
    const paymentBuilder: PaymentBuilder = {
      build: buildPayment,
    };
    const client = new Canix402Client(caller, paymentBuilder);

    const result = await client.getPersonalizedOpportunities("ADDRESS", 10);

    expect(buildPayment).toHaveBeenCalledWith(paymentRequired);
    expect(callTool).toHaveBeenNthCalledWith(
      1,
      "canix_get_personalized_opportunities",
      { address: "ADDRESS", limit: 10, includeInactive: false },
    );
    expect(callTool).toHaveBeenNthCalledWith(
      2,
      "canix_get_personalized_opportunities",
      {
        address: "ADDRESS",
        limit: 10,
        includeInactive: false,
        paymentSignature: "signed-payment",
      },
    );
    expect(result).toMatchObject({
      opportunities: [{ opportunityId: "tinyman:pool:1" }],
      payment: { responseHeader: "settlement" },
    });
  });

  it("pays for and returns general opportunities", async () => {
    const paymentRequired = {
      x402Version: 2,
      resource: {
        url: "https://canix402-api.compx.io/opportunities?limit=5&includeInactive=false",
      },
      accepts: [],
    };
    const callTool = vi
      .fn<ToolCaller["callTool"]>()
      .mockResolvedValueOnce(
        toolResult({
          error: "PAYMENT_REQUIRED",
          mcpPayment: { paymentRequired },
        }),
      )
      .mockResolvedValueOnce(
        toolResult({
          data: [opportunity()],
          mcpPayment: { paymentResponseHeader: "settlement" },
        }),
      );
    const buildPayment = vi.fn().mockResolvedValue({
      paymentSignature: "signed-general-payment",
      receipt: {
        amountBaseUnits: "10000",
        assetId: "31566704",
        network: "algorand:mainnet",
      },
    });
    const client = new Canix402Client(
      {
        callTool,
        close: vi.fn().mockResolvedValue(undefined),
      },
      { build: buildPayment },
    );

    const result = await client.getOpportunities(5);

    expect(buildPayment).toHaveBeenCalledWith(paymentRequired);
    expect(callTool).toHaveBeenNthCalledWith(1, "canix_list_opportunities", {
      limit: 5,
      includeInactive: false,
    });
    expect(callTool).toHaveBeenNthCalledWith(2, "canix_list_opportunities", {
      limit: 5,
      includeInactive: false,
      paymentSignature: "signed-general-payment",
    });
    expect(result.payment?.amountBaseUnits).toBe("10000");
  });

  it("fails closed without a payment signer", async () => {
    const caller: ToolCaller = {
      callTool: vi.fn().mockResolvedValue(
        toolResult({
          error: "PAYMENT_REQUIRED",
          mcpPayment: {
            paymentRequired: {},
            paymentRequiredHeader: "header",
          },
        }),
      ),
      close: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      new Canix402Client(caller, undefined).getPersonalizedOpportunities(
        "ADDRESS",
        10,
      ),
    ).rejects.toThrow(/no local payment signer is configured/);
  });

  it("refuses to pay for a different resource request", async () => {
    const caller: ToolCaller = {
      callTool: vi.fn().mockResolvedValue(
        toolResult({
          error: "PAYMENT_REQUIRED",
          mcpPayment: {
            paymentRequired: {
              resource: {
                url: "https://canix402-api.compx.io/opportunities/personalized?address=OTHER&limit=10",
              },
            },
          },
        }),
      ),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const buildPayment = vi.fn();

    await expect(
      new Canix402Client(caller, {
        build: buildPayment,
      }).getPersonalizedOpportunities("ADDRESS", 10),
    ).rejects.toThrow(/does not match/);
    expect(buildPayment).not.toHaveBeenCalled();
  });

  it("injects the managed wallet and parses paid on-chain positions", async () => {
    const address =
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";
    const paymentRequired = {
      x402Version: 2,
      resource: {
        url: `https://canix402-api.compx.io/positions?address=${address}`,
      },
      accepts: [],
    };
    const callTool = vi
      .fn<ToolCaller["callTool"]>()
      .mockResolvedValueOnce(
        toolResult({
          error: "PAYMENT_REQUIRED",
          mcpPayment: { paymentRequired },
        }),
      )
      .mockResolvedValueOnce(
        toolResult({
          data: [],
          protocols: [],
          totals: {
            suppliedUsd: 0,
            borrowedUsd: 0,
            rewardsUsd: 0,
            netUsd: 0,
          },
          meta: { address, fetchedAt: new Date().toISOString() },
        }),
      );
    const client = new Canix402Client(
      { callTool, close: vi.fn().mockResolvedValue(undefined) },
      {
        build: vi.fn().mockResolvedValue({
          paymentSignature: "positions-payment",
          receipt: {
            amountBaseUnits: "5000",
            assetId: "31566704",
            network: "algorand:mainnet",
          },
        }),
      },
    );

    const result = await client.getPositions(address);

    expect(result.positions.meta.address).toBe(address);
    expect(callTool).toHaveBeenNthCalledWith(1, "canix_get_positions", {
      address,
    });
    expect(callTool).toHaveBeenNthCalledWith(2, "canix_get_positions", {
      address,
      paymentSignature: "positions-payment",
    });
  });

  it("fetches free token prices without a payment builder", async () => {
    const callTool = vi.fn<ToolCaller["callTool"]>().mockResolvedValue(
      toolResult({
        data: {
          prices: [
            { assetId: "0", priceUsd: 0.08 },
            { assetId: "31566704", priceUsd: 1 },
            { assetId: "999", priceUsd: null },
          ],
          source: "compx",
          fetchedAt: "2026-07-16T10:08:49.782Z",
        },
        meta: { paymentRequired: false, executionSubmitted: false },
      }),
    );
    const buildPayment = vi.fn();
    const client = new Canix402Client(
      { callTool, close: vi.fn().mockResolvedValue(undefined) },
      { build: buildPayment },
    );

    const prices = await client.getTokenPrices([0, 31_566_704, 999, 0]);

    expect(buildPayment).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith("canix_get_token_prices", {
      assetIds: [0, 31_566_704, 999],
    });
    expect(prices).toEqual([
      {
        assetId: 0,
        priceUsd: "0.08",
        source: "compx",
        fetchedAt: "2026-07-16T10:08:49.782Z",
        stale: false,
      },
      {
        assetId: 31_566_704,
        priceUsd: "1",
        source: "compx",
        fetchedAt: "2026-07-16T10:08:49.782Z",
        stale: false,
      },
      {
        assetId: 999,
        priceUsd: null,
        source: "compx",
        fetchedAt: "2026-07-16T10:08:49.782Z",
        stale: false,
      },
    ]);
  });

  it("rejects unexpected or duplicate priced asset IDs", async () => {
    const callTool = vi.fn<ToolCaller["callTool"]>().mockResolvedValue(
      toolResult({
        data: {
          prices: [
            { assetId: "0", priceUsd: 1 },
            { assetId: "0", priceUsd: 2 },
          ],
          source: "compx",
          fetchedAt: "2026-07-16T10:08:49.782Z",
        },
        meta: { paymentRequired: false, executionSubmitted: false },
      }),
    );
    const client = new Canix402Client(
      { callTool, close: vi.fn().mockResolvedValue(undefined) },
      undefined,
    );
    await expect(client.getTokenPrices([0])).rejects.toThrow(/Duplicate/);
  });

  it("batches more than 100 asset IDs", async () => {
    const assetIds = Array.from({ length: 101 }, (_, index) => index);
    const callTool = vi
      .fn<ToolCaller["callTool"]>()
      .mockImplementation((_name, args) => {
        const ids = (args as { assetIds: number[] }).assetIds;
        return Promise.resolve(
          toolResult({
            data: {
              prices: ids.map((assetId) => ({
                assetId: String(assetId),
                priceUsd: 1,
              })),
              source: "compx",
              fetchedAt: "2026-07-16T10:08:49.782Z",
            },
            meta: { paymentRequired: false, executionSubmitted: false },
          }),
        );
      });
    const client = new Canix402Client(
      { callTool, close: vi.fn().mockResolvedValue(undefined) },
      undefined,
    );

    const prices = await client.getTokenPrices(assetIds);
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(prices).toHaveLength(101);
  });

  it("removes wallet and payment fields from model-visible tool schemas", async () => {
    const caller: ToolCaller = {
      callTool: vi.fn(),
      listTools: vi.fn().mockResolvedValue([
        {
          name: "canix_swap",
          inputSchema: {
            type: "object",
            properties: {
              address: { type: "string" },
              paymentSignature: { type: "string" },
              quote: {
                type: "object",
                properties: {
                  address: { type: "string" },
                  amount: { type: "string" },
                },
                required: ["address", "amount"],
              },
            },
            required: ["address", "paymentSignature", "quote"],
          },
        },
      ]),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const [tool] = await new Canix402Client(caller, undefined).listAgentTools();

    expect(tool?.inputSchema).toEqual({
      type: "object",
      properties: {
        quote: {
          type: "object",
          properties: { amount: { type: "string" } },
          required: ["amount"],
        },
      },
      required: ["quote"],
    });
  });
});
