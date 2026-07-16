import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

import {
  opportunitySchema,
  walletPositionsSchema,
  type AssetPrice,
  type OpportunityResult,
  type PaymentReceipt,
  type WalletPositions,
} from "../../domain.js";
import { formatMoney, moneyOrNull } from "../../services/money.js";
import type { PaymentBuilder } from "./payment.js";

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  listTools?(): Promise<McpToolDefinition[]>;
  close(): Promise<void>;
}

export class McpSdkToolCaller implements ToolCaller {
  private readonly client = new Client({
    name: "brownie-bot",
    version: "0.1.0",
  });
  private connected = false;

  constructor(private readonly endpoint: URL) {}

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.connected) {
      const transport = new StreamableHTTPClientTransport(this.endpoint);
      await this.client.connect(transport);
      this.connected = true;
    }
    return this.client.callTool({ name, arguments: args });
  }

  async listTools(): Promise<McpToolDefinition[]> {
    await this.ensureConnected();
    const result = await this.client.listTools();
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  async close(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      const transport = new StreamableHTTPClientTransport(this.endpoint);
      await this.client.connect(transport);
      this.connected = true;
    }
  }
}

const preflightSchema = z.object({
  error: z.literal("PAYMENT_REQUIRED"),
  mcpPayment: z.object({
    paymentRequired: z.unknown(),
    paymentRequiredHeader: z.string().optional(),
  }),
  request: z.unknown().optional(),
});

const opportunitiesResponseSchema = z.object({
  data: z.array(opportunitySchema),
  mcpPayment: z
    .object({
      paymentResponseHeader: z.string().optional(),
    })
    .optional(),
});

export interface ManagedToolResult {
  data: unknown;
  payment?: PaymentReceipt;
}

const TOOL_RESOURCE_PATHS: Record<string, string> = {
  canix_list_opportunities: "/opportunities",
  canix_search_opportunities: "/opportunities/search",
  canix_get_personalized_opportunities: "/opportunities/personalized",
  canix_get_positions: "/positions",
  canix_get_execution_quote: "/execution/quotes",
  canix_swap: "/swaps/transactions",
};

export class Canix402Client {
  constructor(
    private readonly caller: ToolCaller,
    private readonly paymentBuilder: PaymentBuilder | undefined,
  ) {}

  async listTools(): Promise<McpToolDefinition[]> {
    if (!this.caller.listTools) {
      return [];
    }
    return this.caller.listTools();
  }

  async listAgentTools(): Promise<McpToolDefinition[]> {
    return prepareAgentTools(await this.listTools());
  }

  async callManagedTool(
    name: string,
    rawArgs: Record<string, unknown>,
    walletAddress: string,
  ): Promise<ManagedToolResult> {
    const args = injectManagedWallet(name, rawArgs, walletAddress);
    const preflight = parseToolPayload(await this.caller.callTool(name, args));
    const parsedPreflight = preflightSchema.safeParse(preflight);
    if (!parsedPreflight.success) {
      if (isToolError(preflight)) {
        throw new Error(formatToolError(preflight));
      }
      return { data: preflight };
    }
    if (!this.paymentBuilder) {
      throw new Error(
        "Canix402 payment is required but no local payment signer is configured",
      );
    }
    assertManagedPaymentResource(
      name,
      parsedPreflight.data.mcpPayment.paymentRequired,
      args,
      walletAddress,
    );
    const builtPayment = await this.paymentBuilder.build(
      parsedPreflight.data.mcpPayment.paymentRequired,
    );
    const paidPayload = parseToolPayload(
      await this.caller.callTool(name, {
        ...args,
        paymentSignature: builtPayment.paymentSignature,
      }),
    );
    if (isToolError(paidPayload)) {
      throw new Error(formatToolError(paidPayload));
    }
    const responseHeader = extractPaymentResponseHeader(paidPayload);
    return {
      data: paidPayload,
      payment: {
        ...builtPayment.receipt,
        responseHeader,
      },
    };
  }

  async getPositions(address: string): Promise<{
    positions: WalletPositions;
    payment?: PaymentReceipt;
  }> {
    const result = await this.callManagedTool(
      "canix_get_positions",
      {},
      address,
    );
    const positions = walletPositionsSchema.parse(result.data);
    if (positions.meta.address !== address) {
      throw new Error(
        "Canix402 positions response address does not match request",
      );
    }
    return { positions, payment: result.payment };
  }

  async getOpportunities(limit: number): Promise<OpportunityResult> {
    const args = { limit, includeInactive: false };
    return this.getPaidOpportunities(
      "canix_list_opportunities",
      args,
      (paymentRequired) =>
        assertPaymentResource(paymentRequired, {
          path: "/opportunities",
          query: { limit: String(limit) },
        }),
    );
  }

  async getPersonalizedOpportunities(
    address: string,
    limit: number,
  ): Promise<OpportunityResult> {
    const args = { address, limit, includeInactive: false };
    return this.getPaidOpportunities(
      "canix_get_personalized_opportunities",
      args,
      (paymentRequired) =>
        assertPaymentResource(paymentRequired, {
          path: "/opportunities/personalized",
          query: { address, limit: String(limit) },
        }),
    );
  }

  private async getPaidOpportunities(
    toolName: string,
    args: Record<string, unknown>,
    validatePaymentResource: (paymentRequired: unknown) => void,
  ): Promise<OpportunityResult> {
    const preflight = parseToolPayload(
      await this.caller.callTool(toolName, args),
    );

    const parsedPreflight = preflightSchema.safeParse(preflight);
    if (!parsedPreflight.success) {
      if (isToolError(preflight)) {
        throw new Error(formatToolError(preflight));
      }
      return {
        opportunities: opportunitiesResponseSchema.parse(preflight).data,
      };
    }
    if (!this.paymentBuilder) {
      throw new Error(
        "Canix402 payment is required but no local payment signer is configured",
      );
    }
    validatePaymentResource(parsedPreflight.data.mcpPayment.paymentRequired);

    const builtPayment = await this.paymentBuilder.build(
      parsedPreflight.data.mcpPayment.paymentRequired,
    );
    const paidPayload = parseToolPayload(
      await this.caller.callTool(toolName, {
        ...args,
        paymentSignature: builtPayment.paymentSignature,
      }),
    );
    if (isToolError(paidPayload)) {
      throw new Error(formatToolError(paidPayload));
    }

    const paidResponse = opportunitiesResponseSchema.parse(paidPayload);
    return {
      opportunities: paidResponse.data,
      payment: {
        ...builtPayment.receipt,
        responseHeader: paidResponse.mcpPayment?.paymentResponseHeader,
      },
    };
  }

  async health(): Promise<unknown> {
    return parseToolPayload(await this.caller.callTool("canix_health", {}));
  }

  async getTokenPrices(assetIds: number[]): Promise<AssetPrice[]> {
    const uniqueOrdered = dedupeAssetIds(assetIds);
    if (uniqueOrdered.length === 0) {
      return [];
    }
    const prices: AssetPrice[] = [];
    for (let offset = 0; offset < uniqueOrdered.length; offset += 100) {
      const batch = uniqueOrdered.slice(offset, offset + 100);
      const payload = parseToolPayload(
        await this.caller.callTool("canix_get_token_prices", {
          assetIds: batch,
        }),
      );
      if (isToolError(payload)) {
        throw new Error(formatToolError(payload));
      }
      prices.push(...normalizeTokenPrices(batch, payload));
    }
    return prices;
  }

  close(): Promise<void> {
    return this.caller.close();
  }
}

const tokenPricesResponseSchema = z.object({
  data: z.object({
    prices: z.array(
      z.object({
        assetId: z.string().regex(/^[0-9]+$/),
        priceUsd: z.number().finite().nullable(),
      }),
    ),
    source: z.string().min(1),
    fetchedAt: z.iso.datetime(),
  }),
  meta: z.object({
    paymentRequired: z.literal(false),
    executionSubmitted: z.literal(false),
  }),
});

function dedupeAssetIds(assetIds: number[]): number[] {
  const seen = new Set<number>();
  const ordered: number[] = [];
  for (const assetId of assetIds) {
    if (!Number.isInteger(assetId) || assetId < 0) {
      throw new Error(`Invalid asset ID for pricing: ${assetId}`);
    }
    if (seen.has(assetId)) {
      continue;
    }
    seen.add(assetId);
    ordered.push(assetId);
  }
  return ordered;
}

function normalizeTokenPrices(
  requestedIds: number[],
  payload: unknown,
): AssetPrice[] {
  const parsed = tokenPricesResponseSchema.parse(payload);
  const byAssetId = new Map<number, { priceUsd: number | null }>();
  for (const entry of parsed.data.prices) {
    const assetId = Number(entry.assetId);
    if (!Number.isSafeInteger(assetId) || assetId < 0) {
      throw new Error(`Invalid priced asset ID: ${entry.assetId}`);
    }
    if (byAssetId.has(assetId)) {
      throw new Error(`Duplicate priced asset ID: ${assetId}`);
    }
    if (!requestedIds.includes(assetId)) {
      throw new Error(`Unexpected priced asset ID: ${assetId}`);
    }
    byAssetId.set(assetId, { priceUsd: entry.priceUsd });
  }
  return requestedIds.map((assetId) => {
    const priced = byAssetId.get(assetId);
    if (!priced) {
      throw new Error(`Missing priced asset ID: ${assetId}`);
    }
    const price = moneyOrNull(priced.priceUsd);
    return {
      assetId,
      priceUsd: price === null ? null : formatMoney(price),
      source: parsed.data.source,
      fetchedAt: parsed.data.fetchedAt,
      stale: false,
    };
  });
}

export function prepareAgentTools(
  tools: McpToolDefinition[],
): McpToolDefinition[] {
  return tools.map((tool) => ({
    ...tool,
    inputSchema: sanitizeToolSchema(tool.inputSchema),
  }));
}

function parseToolPayload(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    throw new Error("Canix402 MCP returned an invalid tool result");
  }
  const content = (result as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    throw new Error("Canix402 MCP tool result has no content");
  }
  const textItem = content.find((item) => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const record = item as Record<string, unknown>;
    return record.type === "text" && typeof record.text === "string";
  }) as Record<string, unknown> | undefined;
  if (!textItem) {
    throw new Error("Canix402 MCP tool result has no text payload");
  }
  const text = textItem.text as string;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Canix402 MCP returned invalid JSON");
  }
}

function isToolError(payload: unknown): payload is {
  error: string;
  message?: string;
} {
  return Boolean(
    payload &&
    typeof payload === "object" &&
    typeof (payload as Record<string, unknown>).error === "string",
  );
}

function formatToolError(payload: { error: string; message?: string }) {
  return payload.message
    ? `Canix402 ${payload.error}: ${payload.message}`
    : `Canix402 ${payload.error}`;
}

interface PaymentResourceExpectation {
  path: string;
  query: Record<string, string>;
}

function assertPaymentResource(
  paymentRequired: unknown,
  expectation: PaymentResourceExpectation,
): void {
  if (!paymentRequired || typeof paymentRequired !== "object") {
    throw new Error("PAYMENT_REQUIRED is malformed");
  }
  const resource = (paymentRequired as Record<string, unknown>).resource;
  if (!resource || typeof resource !== "object") {
    throw new Error("PAYMENT_REQUIRED is missing resource");
  }
  const urlValue = (resource as Record<string, unknown>).url;
  if (typeof urlValue !== "string") {
    throw new Error("PAYMENT_REQUIRED is missing resource.url");
  }
  const url = new URL(urlValue);
  if (url.pathname !== expectation.path) {
    throw new Error(
      "PAYMENT_REQUIRED resource does not match the opportunity request",
    );
  }
  for (const [name, value] of Object.entries(expectation.query)) {
    if (url.searchParams.get(name) !== value) {
      throw new Error(
        "PAYMENT_REQUIRED resource does not match the opportunity request",
      );
    }
  }
  const includeInactive = url.searchParams.get("includeInactive");
  if (includeInactive !== null && includeInactive !== "false") {
    throw new Error("PAYMENT_REQUIRED resource changed includeInactive");
  }
}

function sanitizeToolSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const clone = structuredClone(schema);
  sanitizeSchemaNode(clone);
  return clone;
}

function sanitizeSchemaNode(node: unknown): void {
  if (!node || typeof node !== "object") {
    return;
  }
  const record = node as Record<string, unknown>;
  if (record.properties && typeof record.properties === "object") {
    const properties = record.properties as Record<string, unknown>;
    for (const key of ["paymentSignature", "address", "userAddress"]) {
      delete properties[key];
    }
    for (const value of Object.values(properties)) {
      sanitizeSchemaNode(value);
    }
  }
  if (Array.isArray(record.required)) {
    record.required = record.required.filter(
      (name) =>
        name !== "paymentSignature" &&
        name !== "address" &&
        name !== "userAddress",
    );
  }
  for (const keyword of ["items", "anyOf", "oneOf", "allOf"]) {
    const value = record[keyword];
    if (Array.isArray(value)) {
      value.forEach(sanitizeSchemaNode);
    } else {
      sanitizeSchemaNode(value);
    }
  }
}

function injectManagedWallet(
  toolName: string,
  rawArgs: Record<string, unknown>,
  walletAddress: string,
): Record<string, unknown> {
  const args = structuredClone(rawArgs);
  const addressTools = new Set([
    "canix_get_personalized_opportunities",
    "canix_get_positions",
    "canix_get_quote",
    "canix_optin",
    "canix_swap",
  ]);
  if (addressTools.has(toolName)) {
    args.address = walletAddress;
  }
  if (toolName === "canix_get_execution_quote") {
    const input =
      args.input && typeof args.input === "object"
        ? (args.input as Record<string, unknown>)
        : {};
    args.input = { ...input, userAddress: walletAddress };
  }
  if (
    (toolName === "canix_optin" || toolName === "canix_swap") &&
    args.quote &&
    typeof args.quote === "object"
  ) {
    args.quote = {
      ...(args.quote as Record<string, unknown>),
      address: walletAddress,
    };
  }
  delete args.paymentSignature;
  return args;
}

function assertManagedPaymentResource(
  toolName: string,
  paymentRequired: unknown,
  args: Record<string, unknown>,
  walletAddress: string,
): void {
  if (!paymentRequired || typeof paymentRequired !== "object") {
    throw new Error("PAYMENT_REQUIRED is malformed");
  }
  const resource = (paymentRequired as Record<string, unknown>).resource;
  if (!resource || typeof resource !== "object") {
    throw new Error("PAYMENT_REQUIRED is missing resource");
  }
  const urlValue = (resource as Record<string, unknown>).url;
  if (typeof urlValue !== "string") {
    throw new Error("PAYMENT_REQUIRED is missing resource.url");
  }
  const url = new URL(urlValue);
  const expectedPath =
    toolName === "canix_get_protocol_opportunities"
      ? `/protocols/${String(args.protocol)}/opportunities`
      : TOOL_RESOURCE_PATHS[toolName];
  if (!expectedPath || url.pathname !== expectedPath) {
    throw new Error("PAYMENT_REQUIRED resource does not match MCP tool");
  }
  if (
    ["canix_get_personalized_opportunities", "canix_get_positions"].includes(
      toolName,
    ) &&
    url.searchParams.get("address") !== walletAddress
  ) {
    throw new Error("PAYMENT_REQUIRED resource changed managed wallet");
  }
}

function extractPaymentResponseHeader(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const mcpPayment = (payload as Record<string, unknown>).mcpPayment;
  if (!mcpPayment || typeof mcpPayment !== "object") {
    return undefined;
  }
  const header = (mcpPayment as Record<string, unknown>).paymentResponseHeader;
  return typeof header === "string" ? header : undefined;
}
