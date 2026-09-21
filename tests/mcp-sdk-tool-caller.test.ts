import { beforeEach, describe, expect, it, vi } from "vitest";

const { connect, close, callTool, listTools } = vi.hoisted(() => ({
  connect: vi.fn(),
  close: vi.fn(),
  callTool: vi.fn(),
  listTools: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    connect = connect;
    close = close;
    callTool = callTool;
    listTools = listTools;
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(public endpoint: URL) {}
  },
}));

import {
  MCP_REQUEST_TIMEOUT_MS,
  McpSdkToolCaller,
} from "../src/integrations/canix402/client.js";

describe("McpSdkToolCaller", () => {
  beforeEach(() => {
    connect.mockReset().mockResolvedValue(undefined);
    close.mockReset().mockResolvedValue(undefined);
    callTool.mockReset();
    listTools.mockReset();
  });

  it("uses a 120s request timeout instead of the SDK 60s default", async () => {
    callTool.mockResolvedValue({ content: [] });
    const caller = new McpSdkToolCaller(new URL("https://example.test/mcp"));

    await caller.callTool("canix_get_positions", { address: "ADDR" });

    expect(callTool).toHaveBeenCalledWith(
      { name: "canix_get_positions", arguments: { address: "ADDR" } },
      undefined,
      { timeout: MCP_REQUEST_TIMEOUT_MS, resetTimeoutOnProgress: true },
    );
    expect(MCP_REQUEST_TIMEOUT_MS).toBe(120_000);
  });

  it("reconnects and retries once after MCP request timeout", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    callTool
      .mockRejectedValueOnce(new Error("MCP error -32001: Request timed out"))
      .mockResolvedValueOnce({ content: [{ type: "text", text: "{}" }] });
    const caller = new McpSdkToolCaller(new URL("https://example.test/mcp"));

    await expect(
      caller.callTool("canix_get_positions", {}),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "{}" }],
    });

    expect(close).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Retrying canix_get_positions"),
    );
    errorSpy.mockRestore();
  });

  it("does not retry non-timeout errors", async () => {
    callTool.mockRejectedValueOnce(new Error("Canix402 INTERNAL_ERROR"));
    const caller = new McpSdkToolCaller(new URL("https://example.test/mcp"));

    await expect(caller.callTool("canix_health", {})).rejects.toThrow(
      /INTERNAL_ERROR/,
    );
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it("serializes overlapping MCP calls on one session", async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    callTool.mockImplementation(async (params: { name: string }) => {
      order.push(`start:${params.name}`);
      if (params.name === "canix_get_positions") {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      order.push(`end:${params.name}`);
      return { content: [] };
    });
    const caller = new McpSdkToolCaller(new URL("https://example.test/mcp"));

    const first = caller.callTool("canix_get_positions", {});
    const second = caller.callTool("canix_list_claimable", {});
    await vi.waitFor(() => {
      expect(order).toEqual(["start:canix_get_positions"]);
    });

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual([
      "start:canix_get_positions",
      "end:canix_get_positions",
      "start:canix_list_claimable",
      "end:canix_list_claimable",
    ]);
  });
});
