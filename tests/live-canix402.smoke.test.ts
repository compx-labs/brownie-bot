import { expect, it } from "vitest";

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
        "canix_get_quote",
        "canix_optin",
        "canix_swap",
      ]) {
        expect(toolNames).toContain(required);
      }
    } finally {
      await client.close();
    }
  },
  15_000,
);
