import { expect, it } from "vitest";
import algosdk from "algosdk";

import {
  Canix402Client,
  McpSdkToolCaller,
} from "../src/integrations/canix402/client.js";

const liveIt = process.env.RUN_LIVE_SMOKE === "true" ? it : it.skip;

liveIt(
  "reaches the free Canix402 MCP health tool",
  async () => {
    const client = new Canix402Client(
      new McpSdkToolCaller(
        new URL(
          process.env.CANIX402_MCP_URL ?? "https://canix402-mcp.compx.io/mcp",
        ),
      ),
      undefined,
    );
    try {
      await expect(client.health()).resolves.toMatchObject({
        data: { service: "canix402", status: "ok" },
      });
      const toolNames = new Set(
        (await client.listAgentTools()).map((tool) => tool.name),
      );
      for (const required of [
        "canix_get_positions",
        "canix_list_opportunities",
        "canix_search_opportunities",
        "canix_get_personalized_opportunities",
        "canix_list_execution_shapes",
        "canix_get_execution_quote",
        "canix_compose_enter",
        "canix_get_quote",
        "canix_optin",
        "canix_swap",
        "canix_get_token_prices",
      ]) {
        expect(toolNames).toContain(required);
      }
      const prices = await client.getTokenPrices([0, 31_566_704]);
      expect(prices).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            assetId: 0,
            priceUsd: expect.any(String) as string,
            source: "compx",
          }),
          expect.objectContaining({
            assetId: 31_566_704,
            priceUsd: "1",
            source: "compx",
          }),
        ]),
      );

      const address = algosdk.generateAccount().addr.toString();
      const quote = await client.callManagedTool(
        "canix_get_quote",
        {
          fromAssetId: 0,
          toAssetId: 31_566_704,
          amount: "100000",
          type: "fixed-input",
          slippage: 1,
        },
        address,
      );
      expect(quote.data && typeof quote.data === "object").toBe(true);
      const envelope = quote.data as Record<string, unknown>;
      expect(envelope.data && typeof envelope.data === "object").toBe(true);
      const quoteData = envelope.data as Record<string, unknown>;
      expect([
        "haystack",
        "hogswap",
        "tinyman",
        "pact-smart-router",
        "folks-router",
        "asastats",
      ]).toContain(quoteData.router);
      expect(typeof quoteData.quotedAmount).toBe("string");
      expect(typeof quoteData.minOut).toBe("string");
      expect(quoteData.score && typeof quoteData.score === "object").toBe(true);
      expect(Array.isArray(quoteData.alternatives)).toBe(true);
      expect(quoteData).toHaveProperty("payload");
      expect(envelope.meta).toMatchObject({ executionSubmitted: false });
      expect(quoteData).not.toHaveProperty("txnPayload");
      expect(quoteData).not.toHaveProperty("requiredAppOptIns");
    } finally {
      await client.close();
    }
  },
  30_000,
);
