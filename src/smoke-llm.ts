/**
 * LLM smoke: ZeroSignal (zs-proxy) + one paid Canix research tool.
 * Never quotes swaps, never signs, never moves treasury assets.
 */
import OpenAI from "openai";
import { z } from "zod";

import { loadConfig } from "./config.js";
import {
  Canix402Client,
  McpSdkToolCaller,
  prepareAgentTools,
} from "./integrations/canix402/client.js";
import { AlgorandPaymentBuilder } from "./integrations/canix402/payment.js";
import { walletFromMnemonic } from "./integrations/canix402/wallet.js";
import {
  extractOutputText,
  normalizeAgentResponse,
} from "./services/portfolio-agent.js";

const SMOKE_TOOL = "canix_list_opportunities";
const MAX_TURNS = 4;

const functionCallSchema = z.object({
  type: z.literal("function_call"),
  call_id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string(),
});

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    return value as Record<string, unknown>;
  } catch {
    return {};
  }
}

function countOpportunities(data: unknown): number {
  if (!data || typeof data !== "object") {
    return 0;
  }
  const rows = (data as { data?: unknown }).data;
  return Array.isArray(rows) ? rows.length : 0;
}

export async function runLlmSmoke(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{
  model: string;
  baseURL: string;
  toolCalled: string;
  opportunityCount: number;
  assistantText?: string;
  x402BaseUnits?: string;
}> {
  const config = loadConfig(environment);
  if (config.ENABLE_TRANSACTION_SIGNING) {
    console.warn(
      "[smoke-llm] ENABLE_TRANSACTION_SIGNING=true in env, but this smoke never quotes, swaps, or signs",
    );
  }

  const wallet = walletFromMnemonic(config.WALLET_MNEMONIC);
  const canix = new Canix402Client(
    new McpSdkToolCaller(new URL(config.CANIX402_MCP_URL)),
    new AlgorandPaymentBuilder(wallet, { algodUrl: config.X402_ALGOD_URL }),
  );
  const openai = new OpenAI({
    apiKey: config.OPEN_AI_API_KEY,
    baseURL: config.OPENAI_BASE_URL,
  });

  try {
    const tools = prepareAgentTools(await canix.listTools())
      .filter((tool) => tool.name === SMOKE_TOOL)
      .map((tool) => ({
        type: "function" as const,
        name: tool.name,
        description: tool.description ?? `Call ${tool.name}`,
        strict: false,
        parameters: tool.inputSchema,
      }));
    if (tools.length !== 1) {
      throw new Error(
        `Smoke tool ${SMOKE_TOOL} not available from Canix402 MCP`,
      );
    }

    const initialInput =
      "Call canix_list_opportunities exactly once with limit=3. " +
      "After the tool result, reply with one short sentence confirming how many opportunities were returned. " +
      "Do not call any other tools.";

    let conversationItems: unknown[] = [];
    let response = normalizeAgentResponse(
      await openai.responses.create({
        model: config.OPENAI_MODEL,
        instructions:
          "You are a connectivity smoke test. Use only the provided tool, then answer briefly.",
        input: initialInput,
        tools,
        tool_choice: "auto",
      }),
    );

    let toolCalled: string | undefined;
    let opportunityCount = 0;
    let x402BaseUnits: string | undefined;

    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      const functionCalls = response.output
        .map((item) => functionCallSchema.safeParse(item))
        .flatMap((parsed) => (parsed.success ? [parsed.data] : []));

      if (functionCalls.length === 0) {
        const assistantText =
          response.output_text ?? extractOutputText(response.output);
        if (!toolCalled) {
          throw new Error(
            "LLM finished without calling canix_list_opportunities",
          );
        }
        return {
          model: config.OPENAI_MODEL,
          baseURL: config.OPENAI_BASE_URL,
          toolCalled,
          opportunityCount,
          assistantText,
          x402BaseUnits,
        };
      }

      const outputs: Array<Record<string, unknown>> = [];
      for (const call of functionCalls) {
        if (call.name !== SMOKE_TOOL) {
          outputs.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify({
              error: "TOOL_NOT_ALLOWED",
              message: `Smoke test only allows ${SMOKE_TOOL}`,
            }),
          });
          continue;
        }
        const args = parseArgs(call.arguments);
        const result = await canix.callManagedTool(
          SMOKE_TOOL,
          {
            ...args,
            limit: 3,
            includeInactive: false,
          },
          config.BOT_WALLET,
        );
        toolCalled = SMOKE_TOOL;
        if (result.payment) {
          x402BaseUnits = result.payment.amountBaseUnits;
        }
        opportunityCount = countOpportunities(result.data);
        outputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify({
            ok: true,
            count: opportunityCount,
          }),
        });
      }

      conversationItems = [...conversationItems, ...response.output, ...outputs];
      if (response.id !== undefined) {
        response = normalizeAgentResponse(
          await openai.responses.create({
            model: config.OPENAI_MODEL,
            previous_response_id: response.id,
            input: outputs as unknown as OpenAI.Responses.ResponseInput,
            tools,
            tool_choice: "auto",
          }),
        );
      } else {
        response = normalizeAgentResponse(
          await openai.responses.create({
            model: config.OPENAI_MODEL,
            instructions:
              "You are a connectivity smoke test. Use only the provided tool, then answer briefly.",
            input: [
              { role: "user", content: initialInput },
              ...conversationItems,
            ] as unknown as OpenAI.Responses.ResponseInput,
            tools,
            tool_choice: "auto",
          }),
        );
      }
    }

    throw new Error(`Smoke test exceeded ${MAX_TURNS} LLM turns`);
  } finally {
    await canix.close();
  }
}

const isDirectRun = process.argv[1]?.match(/smoke-llm\.(ts|js)$/) != null;
if (isDirectRun) {
  try {
    const result = await runLlmSmoke();
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "ok",
          ...result,
          note: "No swap quotes, no signing, no treasury movement",
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[smoke-llm] ${message}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.stdout.write(
      `${JSON.stringify({ status: "failed", error: message }, null, 2)}\n`,
    );
    process.exitCode = 1;
  }
}
