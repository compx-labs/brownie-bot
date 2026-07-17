import algosdk from "algosdk";
import { z } from "zod";

import type {
  ExecutionOutcome,
  Opportunity,
  PaymentReceipt,
  PortfolioAction,
} from "../../domain.js";
import type { Canix402Client } from "../canix402/client.js";
import type { TreasuryWallet } from "../canix402/wallet.js";

const executableQuoteSchema = z.object({
  shapeKey: z.string(),
  expiresAt: z.iso.datetime(),
  encodedTransactions: z.array(z.string().min(1)).min(1),
  warnings: z.array(z.string()).default([]),
  transactions: z.array(z.unknown()).default([]),
});

const executionQuoteBatchSchema = z.object({
  data: z.array(executableQuoteSchema).min(1),
  meta: z.object({
    executionSubmitted: z.literal(false),
    quoteCount: z.number().int().positive().optional(),
  }),
});

const haystackQuoteSchema = z.object({
  data: z
    .object({
      address: z.string(),
      fromAssetId: z.string(),
      toAssetId: z.string(),
      amount: z.string(),
      type: z.enum(["fixed-input", "fixed-output"]),
      quotedAmount: z.string(),
      createdAt: z.iso.datetime(),
      expiresAt: z.iso.datetime(),
      requiredAppOptIns: z.array(z.string()),
      txnPayload: z.unknown(),
      userPriceImpact: z.number().optional(),
      marketPriceImpact: z.number().optional(),
      route: z.array(z.unknown()),
      quotes: z.array(z.unknown()),
      protocolFees: z.record(z.string(), z.number()),
    })
    .passthrough(),
  meta: z.object({ executionSubmitted: z.literal(false) }),
});

const walletlessTransactionSchema = z.object({
  index: z.number().int().nonnegative(),
  encodedTransaction: z.string().min(1),
  signedTransaction: z.string().min(1).optional(),
  signer: z.enum(["user", "haystack"]),
});

const walletlessGroupSchema = z.object({
  data: z.object({
    transactions: z.array(walletlessTransactionSchema).min(1),
    userSignIndexes: z.array(z.number().int().nonnegative()),
    createdAt: z.iso.datetime(),
    quoteExpiresAt: z.iso.datetime(),
  }),
  meta: z.object({ executionSubmitted: z.literal(false) }),
});

const optInGroupSchema = z.object({
  data: z.object({
    required: z.boolean(),
    transactions: z.array(
      z.object({
        index: z.number().int().nonnegative(),
        encodedTransaction: z.string().min(1),
        signer: z.literal("user"),
      }),
    ),
    userSignIndexes: z.array(z.number().int().nonnegative()),
    expiresAt: z.iso.datetime(),
  }),
  meta: z.object({ executionSubmitted: z.literal(false) }),
});

export interface ExecutionPolicy {
  signingEnabled: boolean;
  maxSlippageBps: number;
  maxPriceImpactPct: number;
}

export interface ExecuteActionContext {
  opportunities?: Opportunity[];
}

export class AlgorandExecutionService {
  private readonly algod: algosdk.Algodv2;

  constructor(
    private readonly canix: Canix402Client,
    private readonly wallet: TreasuryWallet,
    private readonly managedAddress: string,
    algodUrl: string,
    private readonly policy: ExecutionPolicy,
  ) {
    if (policy.signingEnabled && wallet.address !== managedAddress) {
      throw new Error(
        "Local transaction signer does not match the managed treasury",
      );
    }
    this.algod = new algosdk.Algodv2("", algodUrl, "");
  }

  async executeAction(
    action: PortfolioAction,
    context: ExecuteActionContext = {},
  ): Promise<{
    outcome: ExecutionOutcome;
    payments: PaymentReceipt[];
  }> {
    if (action.type === "hold") {
      return {
        outcome: { actionId: action.id, status: "skipped" },
        payments: [],
      };
    }
    if (!this.policy.signingEnabled) {
      return {
        outcome: { actionId: action.id, status: "validated-dry-run" },
        payments: [],
      };
    }
    try {
      return action.type === "swap"
        ? await this.executeSwap(action)
        : await this.executeShape(action, context.opportunities ?? []);
    } catch (error) {
      return {
        outcome: {
          actionId: action.id,
          status: "failed",
          error: formatExecutionError(error),
        },
        payments: [],
      };
    }
  }

  private async executeShape(
    action: PortfolioAction,
    opportunities: Opportunity[],
  ): Promise<{
    outcome: ExecutionOutcome;
    payments: PaymentReceipt[];
  }> {
    if (!action.executionShapeKey || !action.executionInput) {
      throw new Error(`Action ${action.id} has no execution shape`);
    }
    const quotes = buildQuoteRequests(
      action,
      opportunities,
      this.policy.maxSlippageBps,
    );
    const result = await this.canix.callManagedTool(
      "canix_get_execution_quote",
      { quotes },
      this.managedAddress,
    );
    const batch = executionQuoteBatchSchema.parse(result.data);
    if (batch.data.length !== quotes.length) {
      throw new Error(
        `Execution quote count mismatch: requested ${quotes.length}, received ${batch.data.length}`,
      );
    }
    let lastOutcome: ExecutionOutcome = {
      actionId: action.id,
      status: "failed",
      error: "No execution quotes returned",
    };
    for (const [index, quote] of batch.data.entries()) {
      assertFresh(quote.expiresAt);
      const submit = await this.signAndSubmit(
        batch.data.length === 1 ? action.id : `${action.id}:${index}`,
        quote.encodedTransactions.map((encoded) => ({
          encoded,
          signer: "user" as const,
        })),
      );
      lastOutcome = {
        ...submit.outcome,
        actionId: action.id,
        toolName: "canix_get_execution_quote",
      };
      if (submit.outcome.status !== "confirmed") {
        return {
          outcome: lastOutcome,
          payments: result.payment ? [result.payment] : [],
        };
      }
    }
    return {
      outcome: lastOutcome,
      payments: result.payment ? [result.payment] : [],
    };
  }

  private async executeSwap(action: PortfolioAction): Promise<{
    outcome: ExecutionOutcome;
    payments: PaymentReceipt[];
  }> {
    if (
      action.fromAssetId === null ||
      action.toAssetId === null ||
      action.amountRaw === null
    ) {
      throw new Error(`Swap action ${action.id} is missing assets or amount`);
    }
    let quoteResult = await this.canix.callManagedTool(
      "canix_get_quote",
      {
        fromAssetId: action.fromAssetId,
        toAssetId: action.toAssetId,
        amount: action.amountRaw,
        type: "fixed-input",
      },
      this.managedAddress,
    );
    let quote = haystackQuoteSchema.parse(quoteResult.data);
    assertFresh(quote.data.expiresAt);
    if ((quote.data.userPriceImpact ?? 0) > this.policy.maxPriceImpactPct) {
      throw new Error(
        `Haystack price impact exceeds ${this.policy.maxPriceImpactPct}%`,
      );
    }

    const optInResult = await this.canix.callManagedTool(
      "canix_optin",
      { quote: quote.data },
      this.managedAddress,
    );
    const optIn = optInGroupSchema.parse(optInResult.data);
    if (optIn.data.required) {
      const optInOutcome = await this.signAndSubmit(
        `${action.id}:optin`,
        optIn.data.transactions.map((transaction) => ({
          encoded: transaction.encodedTransaction,
          signer: "user" as const,
        })),
      );
      if (optInOutcome.outcome.status !== "confirmed") {
        return {
          outcome: {
            actionId: action.id,
            status: optInOutcome.outcome.status,
            toolName: "canix_optin",
            error:
              optInOutcome.outcome.status === "validated-dry-run"
                ? "Swap requires opt-ins; execution awaits signing"
                : optInOutcome.outcome.error,
          },
          payments: [],
        };
      }
      quoteResult = await this.canix.callManagedTool(
        "canix_get_quote",
        {
          fromAssetId: action.fromAssetId,
          toAssetId: action.toAssetId,
          amount: action.amountRaw,
          type: "fixed-input",
        },
        this.managedAddress,
      );
      quote = haystackQuoteSchema.parse(quoteResult.data);
      assertFresh(quote.data.expiresAt);
    }

    const swapResult = await this.canix.callManagedTool(
      "canix_swap",
      {
        quote: quote.data,
        slippage: this.policy.maxSlippageBps / 100,
      },
      this.managedAddress,
    );
    const group = walletlessGroupSchema.parse(swapResult.data);
    assertFresh(group.data.quoteExpiresAt);
    const outcome = await this.signAndSubmit(
      action.id,
      group.data.transactions.map((transaction) => ({
        encoded: transaction.encodedTransaction,
        signer: transaction.signer,
        signed: transaction.signedTransaction,
      })),
    );
    return {
      outcome: { ...outcome.outcome, toolName: "canix_swap" },
      payments: swapResult.payment ? [swapResult.payment] : [],
    };
  }

  private async signAndSubmit(
    actionId: string,
    members: Array<{
      encoded: string;
      signer: "user" | "haystack";
      signed?: string;
    }>,
  ): Promise<{
    outcome: ExecutionOutcome;
  }> {
    if (!this.policy.signingEnabled) {
      return {
        outcome: { actionId, status: "validated-dry-run" },
      };
    }
    const signed = members.map((member) => {
      if (member.signer === "user") {
        return signEncodedTransaction(member.encoded, this.wallet.secretKey);
      }
      if (!member.signed) {
        throw new Error(
          "Haystack transaction is missing its provider signature",
        );
      }
      return new Uint8Array(Buffer.from(member.signed, "base64"));
    });
    const submitted = (await this.algod.sendRawTransaction(signed).do()) as {
      txid: string;
    };
    const confirmation = await algosdk.waitForConfirmation(
      this.algod,
      submitted.txid,
      8,
    );
    return {
      outcome: {
        actionId,
        status: "confirmed",
        transactionId: submitted.txid,
        confirmedRound: confirmation.confirmedRound?.toString(),
      },
    };
  }
}

export function buildQuoteRequests(
  action: PortfolioAction,
  opportunities: Opportunity[],
  maxSlippageBps: number,
): Array<{ shapeKey: string; input: Record<string, unknown> }> {
  const opportunity = action.opportunityId
    ? opportunities.find(
        (candidate) => candidate.opportunityId === action.opportunityId,
      )
    : undefined;
  const baseInput = {
    ...(action.executionInput ?? {}),
    maxSlippageBps,
  };
  if (
    ["open", "increase"].includes(action.type) &&
    opportunity &&
    opportunity.executionShapes.length > 0
  ) {
    const shapes = [...opportunity.executionShapes].sort(
      (left, right) =>
        left.order - right.order || left.shapeKey.localeCompare(right.shapeKey),
    );
    return shapes.map((shape) => ({
      shapeKey: shape.shapeKey,
      input: {
        ...(shape.inputHints ?? {}),
        ...baseInput,
      },
    }));
  }
  return [
    {
      shapeKey: action.executionShapeKey!,
      input: baseInput,
    },
  ];
}

function formatExecutionError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Unknown execution error";
  }
  const details = (error as Error & { details?: unknown }).details;
  if (details && typeof details === "object") {
    const record = details as Record<string, unknown>;
    const parts = [
      typeof record.quoteIndex === "number"
        ? `quoteIndex=${record.quoteIndex}`
        : null,
      typeof record.shapeKey === "string"
        ? `shapeKey=${record.shapeKey}`
        : null,
    ].filter(Boolean);
    if (parts.length > 0) {
      return `${error.message} (${parts.join(", ")})`;
    }
  }
  return error.message;
}

function assertFresh(expiresAt: string): void {
  if (new Date(expiresAt).getTime() <= Date.now() + 2_000) {
    throw new Error("Execution quote is expired or too close to expiry");
  }
}

function signEncodedTransaction(
  encodedTransaction: string,
  secretKey: Uint8Array,
): Uint8Array {
  // algosdk signs via a Transaction instance; do not inspect MCP-returned fields.
  const transaction = algosdk.decodeUnsignedTransaction(
    Buffer.from(encodedTransaction, "base64"),
  );
  return transaction.signTxn(secretKey);
}
