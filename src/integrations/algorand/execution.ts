import { randomUUID } from "node:crypto";

import algosdk from "algosdk";
import { z } from "zod";

import type {
  ExecutionOutcome,
  Opportunity,
  OpportunityExecutionShape,
  PaymentReceipt,
  PortfolioAction,
} from "../../domain.js";
import type { Canix402Client } from "../canix402/client.js";
import type { TreasuryWallet } from "../canix402/wallet.js";
import type { FolksEscrowStore } from "./folks-escrow-store.js";
import {
  classifyFolksShape,
  needsSequentialEscrowExecution,
  resolveDepositAssetId,
  resolvePoolAppId,
  selectEscrowShapesToRun,
  sortExecutionShapes,
} from "./folks-execution.js";

const executableQuoteSchema = z.object({
  shapeKey: z.string(),
  expiresAt: z.iso.datetime(),
  encodedTransactions: z.array(z.string().min(1)).min(1),
  warnings: z.array(z.string()).default([]),
  transactions: z.array(z.unknown()).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
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
    private readonly folksEscrowStore?: FolksEscrowStore,
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
    const opportunity = action.opportunityId
      ? opportunities.find(
          (candidate) => candidate.opportunityId === action.opportunityId,
        )
      : undefined;
    if (
      opportunity &&
      ["open", "increase"].includes(action.type) &&
      needsSequentialEscrowExecution(opportunity.executionShapes)
    ) {
      return this.executeSequentialEscrowShapes(action, opportunity);
    }
    return this.executeBatchedShapes(action, opportunities);
  }

  private async executeBatchedShapes(
    action: PortfolioAction,
    opportunities: Opportunity[],
  ): Promise<{
    outcome: ExecutionOutcome;
    payments: PaymentReceipt[];
  }> {
    const opportunity = action.opportunityId
      ? opportunities.find(
          (candidate) => candidate.opportunityId === action.opportunityId,
        )
      : undefined;
    const enrichedAction: PortfolioAction = {
      ...action,
      executionInput: await this.enrichShapeExecutionInput(action, opportunity),
    };
    const quotes = buildQuoteRequests(
      enrichedAction,
      opportunities,
      this.policy.maxSlippageBps,
    );
    const receiveAssetIds = collectPotentialReceiveAssetIds(
      enrichedAction,
      opportunity,
    );
    const extraSigners = await this.folksExitExtraSigners(
      enrichedAction,
      opportunity,
    );

    // Pact farm:deployEscrow (and similar) must confirm before the capital
    // enter shape can be quoted — batch quoting would fail hasEscrow checks.
    if (quotesNeedSequentialConfirm(quotes)) {
      return this.executeSequentialQuoteSteps(
        enrichedAction,
        quotes,
        receiveAssetIds,
        extraSigners,
      );
    }

    const { batch, payments } = await this.requestQuotes(
      enrichedAction.id,
      quotes,
    );
    let lastOutcome: ExecutionOutcome = {
      actionId: enrichedAction.id,
      status: "failed",
      error: "No execution quotes returned",
    };

    for (const [index, quote] of batch.data.entries()) {
      assertFresh(quote.expiresAt);
      const encoded = await this.withLeadingAssetOptIns(
        quote.encodedTransactions,
        [
          ...receiveAssetIds,
          ...collectReceiveAssetIdsFromQuoteMetadata(quote.metadata),
        ],
      );
      const submit = await this.signAndSubmitEncoded(
        batch.data.length === 1
          ? enrichedAction.id
          : `${enrichedAction.id}:${index}`,
        encoded,
        extraSigners,
      );
      lastOutcome = {
        ...submit.outcome,
        actionId: enrichedAction.id,
        toolName: "canix_get_execution_quote",
      };
      if (submit.outcome.status !== "confirmed") {
        return { outcome: lastOutcome, payments };
      }
    }
    return { outcome: lastOutcome, payments };
  }

  /**
   * Quote and submit one shape at a time so post-confirm prerequisites
   * (deployEscrow) are visible to the next quote.
   */
  private async executeSequentialQuoteSteps(
    action: PortfolioAction,
    quotes: Array<{ shapeKey: string; input: Record<string, unknown> }>,
    receiveAssetIds: number[],
    extraSigners: Map<string, Uint8Array>,
  ): Promise<{
    outcome: ExecutionOutcome;
    payments: PaymentReceipt[];
  }> {
    const payments: PaymentReceipt[] = [];
    let lastOutcome: ExecutionOutcome = {
      actionId: action.id,
      status: "failed",
      error: "No execution quotes returned",
    };

    for (const [index, quoteRequest] of quotes.entries()) {
      const stepLabel =
        quotes.length === 1 ? action.id : `${action.id}:${index}`;
      let batch: z.infer<typeof executionQuoteBatchSchema>;
      try {
        const result = await this.requestQuotes(stepLabel, [quoteRequest]);
        batch = result.batch;
        payments.push(...result.payments);
      } catch (error) {
        if (isSkippablePrerequisiteQuoteError(quoteRequest.shapeKey, error)) {
          console.error(
            `[execution] Skipping already-complete prerequisite ${quoteRequest.shapeKey} for ${action.id}`,
          );
          continue;
        }
        throw error;
      }

      const quote = batch.data[0]!;
      assertFresh(quote.expiresAt);
      const submit = await this.signAndSubmitEncoded(
        stepLabel,
        await this.withLeadingAssetOptIns(quote.encodedTransactions, [
          ...receiveAssetIds,
          ...collectReceiveAssetIdsFromQuoteMetadata(quote.metadata),
        ]),
        extraSigners,
      );
      lastOutcome = {
        ...submit.outcome,
        actionId: action.id,
        toolName: "canix_get_execution_quote",
      };
      if (submit.outcome.status !== "confirmed") {
        return { outcome: lastOutcome, payments };
      }
    }
    return { outcome: lastOutcome, payments };
  }

  /**
   * Folks withdraw/exit quotes need escrowAddress + amount fields; deposit-style
   * assetAmount alone is not enough. Pull escrow from the local store when known.
   */
  private async enrichShapeExecutionInput(
    action: PortfolioAction,
    opportunity: Opportunity | undefined,
  ): Promise<Record<string, unknown>> {
    const input: Record<string, unknown> = { ...(action.executionInput ?? {}) };
    const shapeKey = action.executionShapeKey ?? "";
    const isFolksWithdraw =
      /folks/i.test(shapeKey) && /withdraw/i.test(shapeKey);

    if (
      ["reduce", "close"].includes(action.type) &&
      isFolksWithdraw
    ) {
      if (input.amount === undefined && action.amountRaw) {
        input.amount = action.amountRaw;
      }
      if (input.amountDenomination === undefined) {
        // Match Canix Folks live round-trip: withdraw in underlying asset units.
        input.amountDenomination = "asset";
      }
      // Withdraw shape only accepts amount / amountDenomination (not deposit fields).
      delete input.assetAmount;
      delete input.liquidityAssetAmount;
      if (input.poolAppId === undefined && opportunity) {
        const poolAppId = resolvePoolAppId(
          opportunity.executionShapes,
          input,
        );
        if (poolAppId !== undefined) {
          input.poolAppId = poolAppId;
        }
      }
      // Canix withdraw rejects poolAppId + assetId together; prefer poolAppId.
      if (input.poolAppId !== undefined) {
        delete input.assetId;
      }
      if (
        typeof input.escrowAddress !== "string" &&
        this.folksEscrowStore &&
        typeof input.poolAppId === "number"
      ) {
        const escrow = await this.folksEscrowStore.get(
          this.managedAddress,
          input.poolAppId,
        );
        if (escrow) {
          input.escrowAddress = escrow.escrowAddress;
        }
      }
    }

    return input;
  }

  private async folksExitExtraSigners(
    action: PortfolioAction,
    opportunity: Opportunity | undefined,
  ): Promise<Map<string, Uint8Array>> {
    const signers = new Map<string, Uint8Array>();
    const shapeKey = action.executionShapeKey ?? "";
    if (
      !this.folksEscrowStore ||
      !["reduce", "close"].includes(action.type) ||
      !/folks/i.test(shapeKey)
    ) {
      return signers;
    }
    const poolAppId = resolvePoolAppId(
      opportunity?.executionShapes ?? [],
      action.executionInput ?? {},
    );
    if (poolAppId === undefined) {
      return signers;
    }
    const escrow = await this.folksEscrowStore.get(
      this.managedAddress,
      poolAppId,
    );
    if (escrow) {
      signers.set(
        escrow.escrowAddress,
        secretKeyFromBase64(escrow.escrowPrivateKeyBase64),
      );
    }
    return signers;
  }

  private async executeSequentialEscrowShapes(
    action: PortfolioAction,
    opportunity: Opportunity,
  ): Promise<{
    outcome: ExecutionOutcome;
    payments: PaymentReceipt[];
  }> {
    if (!this.folksEscrowStore) {
      throw new Error(
        "Folks escrow store is not configured; cannot run sequential escrow setup",
      );
    }
    const shapes = sortExecutionShapes(opportunity.executionShapes);
    const poolAppId = resolvePoolAppId(shapes, action.executionInput ?? {});
    if (poolAppId === undefined) {
      throw new Error(
        `Action ${action.id} is missing poolAppId for Folks escrow execution`,
      );
    }
    const assetId = resolveDepositAssetId(
      shapes,
      action.executionInput ?? {},
      action.fromAssetId,
    );
    if (assetId === undefined) {
      throw new Error(
        `Action ${action.id} is missing assetId for Folks escrow execution`,
      );
    }

    let escrow = await this.folksEscrowStore.get(this.managedAddress, poolAppId);
    const escrowOptedIntoAsset = escrow
      ? await this.isAssetOptedIn(escrow.escrowAddress, assetId)
      : false;
    const selected = selectEscrowShapesToRun(shapes, {
      hasEscrow: Boolean(escrow),
      escrowOptedIntoAsset,
    });
    if (selected.length === 0) {
      throw new Error(`Action ${action.id} selected no Folks execution shapes`);
    }

    console.error(
      `[execution] Folks sequential for ${action.id}: ${selected
        .map((shape) => `${classifyFolksShape(shape)}:${shape.shapeKey}`)
        .join(" → ")} (escrow=${escrow ? "present" : "missing"}, opted=${escrowOptedIntoAsset})`,
    );

    const payments: PaymentReceipt[] = [];
    let lastOutcome: ExecutionOutcome = {
      actionId: action.id,
      status: "failed",
      error: "No Folks steps executed",
    };
    let escrowSecretKey = escrow
      ? secretKeyFromBase64(escrow.escrowPrivateKeyBase64)
      : undefined;

    for (const shape of selected) {
      const input = {
        ...buildShapeInput(
          shape,
          {
            ...(action.executionInput ?? {}),
            ...(escrow ? { escrowAddress: escrow.escrowAddress } : {}),
          },
          this.policy.maxSlippageBps,
        ),
        ...(escrow ? { escrowAddress: escrow.escrowAddress } : {}),
      };
      const { batch, payments: stepPayments } = await this.requestQuotes(
        `${action.id}:${classifyFolksShape(shape)}`,
        [{ shapeKey: shape.shapeKey, input }],
      );
      payments.push(...stepPayments);
      const quote = batch.data[0]!;
      assertFresh(quote.expiresAt);

      const metadataEscrow = readEscrowMetadata(quote.metadata);
      if (metadataEscrow?.escrowPrivateKeyBase64) {
        escrowSecretKey = secretKeyFromBase64(
          metadataEscrow.escrowPrivateKeyBase64,
        );
      }
      const extraSigners = new Map<string, Uint8Array>();
      const escrowAddress =
        metadataEscrow?.escrowAddress ?? escrow?.escrowAddress;
      if (escrowAddress && escrowSecretKey) {
        extraSigners.set(escrowAddress, escrowSecretKey);
      }

      const submit = await this.signAndSubmitEncoded(
        `${action.id}:${classifyFolksShape(shape)}`,
        await this.withLeadingAssetOptIns(quote.encodedTransactions, [
          ...collectPotentialReceiveAssetIds(action, opportunity),
          ...collectReceiveAssetIdsFromQuoteMetadata(quote.metadata),
        ]),
        extraSigners,
      );
      lastOutcome = {
        ...submit.outcome,
        actionId: action.id,
        toolName: "canix_get_execution_quote",
      };
      if (submit.outcome.status !== "confirmed") {
        return { outcome: lastOutcome, payments };
      }

      if (classifyFolksShape(shape) === "setup") {
        if (
          !metadataEscrow?.escrowAddress ||
          !metadataEscrow.escrowPrivateKeyBase64
        ) {
          throw new Error(
            `Folks setup quote for ${action.id} did not return escrowAddress/escrowPrivateKeyBase64 metadata`,
          );
        }
        escrow = await this.folksEscrowStore.save({
          walletAddress: this.managedAddress,
          poolAppId,
          depositsAppId: metadataEscrow.depositsAppId,
          escrowAddress: metadataEscrow.escrowAddress,
          escrowPrivateKeyBase64: metadataEscrow.escrowPrivateKeyBase64,
        });
        escrowSecretKey = secretKeyFromBase64(
          metadataEscrow.escrowPrivateKeyBase64,
        );
        console.error(
          `[execution] Persisted Folks escrow ${escrow.escrowAddress} for pool ${poolAppId}`,
        );
      }
    }

    return { outcome: lastOutcome, payments };
  }

  private async requestQuotes(
    label: string,
    quotes: Array<{ shapeKey: string; input: Record<string, unknown> }>,
  ): Promise<{
    batch: z.infer<typeof executionQuoteBatchSchema>;
    payments: PaymentReceipt[];
  }> {
    console.error(
      `[execution] Requesting ${quotes.length} quote(s) for ${label}: ${quotes
        .map((quote) => quote.shapeKey)
        .join(" → ")}`,
    );
    console.error(
      `[execution] Quote payload: ${JSON.stringify({ quotes }, null, 2)}`,
    );
    try {
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
      return {
        batch,
        payments: result.payment ? [result.payment] : [],
      };
    } catch (error) {
      console.error(
        `[execution] canix_get_execution_quote failed for ${label}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  }

  private async isAssetOptedIn(
    address: string,
    assetId: number,
  ): Promise<boolean> {
    try {
      await this.algod.accountAssetInformation(address, assetId).do();
      return true;
    } catch (error) {
      if (isAccountAssetMissing(error)) {
        return false;
      }
      throw error;
    }
  }

  /**
   * If the treasury is missing ASA opt-ins for assets the action may receive
   * (e.g. xALGO from Folks stake), prepend self opt-in transfers as the leading
   * transactions in the atomic group before payment/app calls.
   */
  private async withLeadingAssetOptIns(
    encodedTransactions: string[],
    assetIds: number[],
  ): Promise<string[]> {
    const missing: number[] = [];
    for (const assetId of assetIds) {
      if (assetId <= 0) {
        continue;
      }
      if (!(await this.isAssetOptedIn(this.managedAddress, assetId))) {
        missing.push(assetId);
      }
    }
    if (missing.length === 0) {
      return encodedTransactions;
    }
    console.error(
      `[execution] Prepending ASA opt-in(s) for asset(s) ${missing.join(", ")} before execution group`,
    );
    return prependAssetOptInTransactions(
      encodedTransactions,
      this.managedAddress,
      missing,
    );
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

  private async signAndSubmitEncoded(
    actionId: string,
    encodedTransactions: string[],
    extraSigners: Map<string, Uint8Array> = new Map(),
  ): Promise<{ outcome: ExecutionOutcome }> {
    if (!this.policy.signingEnabled) {
      return { outcome: { actionId, status: "validated-dry-run" } };
    }
    // Canix quotes are deterministic within a validity window; unique notes
    // keep retries/re-runs from colliding with already-confirmed txids.
    const uniqueEncoded = applyUniqueTransactionNotes(
      encodedTransactions,
      actionId,
    );
    const signed = uniqueEncoded.map((encoded) => {
      const transaction = algosdk.decodeUnsignedTransaction(
        Buffer.from(encoded, "base64"),
      );
      const sender = transaction.sender.toString();
      if (sender === this.managedAddress) {
        return signTransaction(transaction, this.wallet.secretKey);
      }
      const escrowKey = extraSigners.get(sender);
      if (escrowKey) {
        return signTransaction(transaction, escrowKey);
      }
      throw new Error(
        `No signer available for transaction sender ${sender} in ${actionId}`,
      );
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
    // Only rewrite notes when every member is user-signed (e.g. opt-in groups).
    // Haystack co-signed groups cannot be regrouped without invalidating provider signatures.
    const allUserSigned = members.every((member) => member.signer === "user");
    const uniqueEncoded = allUserSigned
      ? applyUniqueTransactionNotes(
          members.map((member) => member.encoded),
          actionId,
        )
      : null;
    const signed = members.map((member, index) => {
      if (member.signer === "user") {
        return signEncodedTransaction(
          uniqueEncoded?.[index] ?? member.encoded,
          this.wallet.secretKey,
        );
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

/**
 * Exit / redeem shapes must never be batched into an open/increase enter path.
 * (e.g. Folks xALGO unstake attached beside stake for later exit quoting.)
 */
export function isExitOrRedeemShape(shape: OpportunityExecutionShape): boolean {
  const key =
    `${shape.shapeKey}:${shape.action}:${shape.variant}`.toLowerCase();
  return /unstake|redeem|removeLiquidity|withdraw|burn|claim/.test(key);
}

/** Setup / opt-in / escrow-deploy prerequisites that may precede a capital-enter shape. */
export function isSetupOrPrerequisiteShape(
  shape: OpportunityExecutionShape,
): boolean {
  const action = shape.action.toLowerCase();
  const variant = shape.variant.toLowerCase();
  const key = shape.shapeKey.toLowerCase();
  return (
    /setup|optin|create|deployescrow/i.test(action) ||
    /setup|opt|deployescrow/i.test(variant) ||
    key.includes(":setup:") ||
    key.includes("deployescrow") ||
    /:opt(?:in|escrow)?(?::|$)/i.test(key)
  );
}

/**
 * Prerequisites that must confirm on-chain before the next shape can be quoted
 * (e.g. Pact farm:deployEscrow — escrow app id is only known post-confirm).
 */
export function isPostConfirmPrerequisiteShape(
  shape: Pick<OpportunityExecutionShape, "shapeKey" | "action" | "variant">,
): boolean {
  const key = `${shape.shapeKey}:${shape.action}:${shape.variant}`.toLowerCase();
  return /deployescrow/.test(key);
}

export function quotesNeedSequentialConfirm(
  quotes: Array<{ shapeKey: string }>,
): boolean {
  return quotes.some((quote) => /deployescrow/i.test(quote.shapeKey));
}

/** deployEscrow quote fails when escrow already exists — safe to skip. */
export function isSkippablePrerequisiteQuoteError(
  shapeKey: string,
  error: unknown,
): boolean {
  if (!/deployescrow/i.test(shapeKey)) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /already has .*escrow|escrow already/i.test(message);
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
  const executionInput = action.executionInput ?? {};
  if (
    ["open", "increase"].includes(action.type) &&
    opportunity &&
    opportunity.executionShapes.length > 0 &&
    !needsSequentialEscrowExecution(opportunity.executionShapes)
  ) {
    const shapes = sortExecutionShapes(opportunity.executionShapes);
    const targetKey = action.executionShapeKey!;
    const target = shapes.find((shape) => shape.shapeKey === targetKey);

    // LST unstake (and similar) may be modeled as open against an exit shape —
    // quote only that shape, never the paired stake/deposit enter shapes.
    if (target && isExitOrRedeemShape(target)) {
      return [
        {
          shapeKey: target.shapeKey,
          input: buildShapeInput(target, executionInput, maxSlippageBps),
        },
      ];
    }

    // Enter path: the chosen capital-enter shape plus any setup prerequisites.
    // Do NOT batch sibling enter variants (e.g. Tinyman initial/singleAsset
    // when the action targets flexible).
    const selected = shapes.filter((shape) => {
      if (isExitOrRedeemShape(shape)) {
        return false;
      }
      if (shape.shapeKey === targetKey) {
        return true;
      }
      if (!target) {
        return false;
      }
      return (
        isSetupOrPrerequisiteShape(shape) && shape.order <= target.order
      );
    });
    if (selected.length === 0) {
      return [
        {
          shapeKey: targetKey,
          input: {
            ...executionInput,
            maxSlippageBps,
          },
        },
      ];
    }
    return selected.map((shape) => ({
      shapeKey: shape.shapeKey,
      input: buildShapeInput(shape, executionInput, maxSlippageBps),
    }));
  }
  return [
    {
      shapeKey: action.executionShapeKey!,
      input: {
        ...executionInput,
        maxSlippageBps,
      },
    },
  ];
}

/**
 * ASA IDs the wallet may receive from an enter/exit (excludes native ALGO).
 * Used to decide whether a leading self opt-in is required in the group.
 */
export function collectPotentialReceiveAssetIds(
  action: PortfolioAction,
  opportunity: Opportunity | undefined,
): number[] {
  const ids = new Set<number>();
  for (const assetId of opportunity?.assetIds ?? []) {
    if (assetId > 0) {
      ids.add(assetId);
    }
  }
  for (const shape of opportunity?.executionShapes ?? []) {
    for (const assetId of shape.requiredAssetIds) {
      if (assetId > 0) {
        ids.add(assetId);
      }
    }
    const hints = shape.inputHints;
    if (!hints) {
      continue;
    }
    for (const key of [
      "liquidityAssetId",
      "assetId",
      "assetAId",
      "assetBId",
      "depositAssetId",
    ] as const) {
      const value = hints[key];
      if (typeof value === "number" && value > 0) {
        ids.add(value);
      }
    }
  }
  if (action.toAssetId !== null && action.toAssetId > 0) {
    ids.add(action.toAssetId);
  }
  return [...ids].sort((left, right) => left - right);
}

/**
 * LP / receipt ASAs exposed on Canix quote metadata (Tinyman poolTokenId,
 * Pact liquidityAssetId, etc.) that opportunity.assetIds often omit.
 */
export function collectReceiveAssetIdsFromQuoteMetadata(
  metadata: Record<string, unknown> | undefined,
): number[] {
  if (!metadata) {
    return [];
  }
  const ids = new Set<number>();
  for (const key of [
    "poolTokenId",
    "liquidityAssetId",
    "liquidityAssetID",
  ] as const) {
    const value = metadata[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      ids.add(value);
      continue;
    }
    if (typeof value === "string" && /^\d+$/.test(value)) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        ids.add(parsed);
      }
    }
  }
  return [...ids].sort((left, right) => left - right);
}

const MAX_NOTE_BYTES = 1_024;
const NOTE_ENCODER = new TextEncoder();

/**
 * Stamp a per-submit nonce onto each transaction note and rebuild the group.
 * Canix execution quotes are deterministic for identical inputs within a validity
 * window; without unique notes, retries collide with already-confirmed txids
 * ("transaction already in ledger").
 *
 * Existing notes are preserved as a prefix (protocol-required note prefixes keep
 * working) and a `|brownie|<actionId>|<nonce>|<index>` suffix is appended.
 */
export function applyUniqueTransactionNotes(
  encodedTransactions: string[],
  actionId: string,
  nonce: string = randomUUID(),
): string[] {
  if (encodedTransactions.length === 0) {
    return encodedTransactions;
  }
  const transactions = encodedTransactions.map((encoded, index) => {
    const transaction = algosdk.decodeUnsignedTransaction(
      Buffer.from(encoded, "base64"),
    );
    // decodeUnsignedTransaction returns a mutable wire object; note/group are
    // typed readonly on Transaction but must be rewritten before re-signing.
    const mutable = transaction as algosdk.Transaction & {
      group?: Uint8Array;
      note?: Uint8Array;
    };
    mutable.group = undefined;
    mutable.note = buildUniqueNote(transaction.note, actionId, nonce, index);
    return transaction;
  });
  const grouped =
    transactions.length === 1
      ? transactions
      : algosdk.assignGroupID(transactions);
  return grouped.map((transaction) =>
    Buffer.from(algosdk.encodeUnsignedTransaction(transaction)).toString(
      "base64",
    ),
  );
}

function buildUniqueNote(
  existingNote: Uint8Array | undefined,
  actionId: string,
  nonce: string,
  index: number,
): Uint8Array {
  const uniqueSuffix = NOTE_ENCODER.encode(
    `|brownie|${actionId}|${nonce}|${index}`,
  );
  if (!existingNote || existingNote.length === 0) {
    // Drop the leading "|" when there is no protocol note to preserve.
    return NOTE_ENCODER.encode(`brownie|${actionId}|${nonce}|${index}`);
  }
  if (existingNote.length + uniqueSuffix.length <= MAX_NOTE_BYTES) {
    const combined = new Uint8Array(existingNote.length + uniqueSuffix.length);
    combined.set(existingNote, 0);
    combined.set(uniqueSuffix, existingNote.length);
    return combined;
  }
  // Prefer uniqueness over preserving an oversized protocol note.
  return NOTE_ENCODER.encode(`brownie|${actionId}|${nonce}|${index}`);
}

/**
 * Rebuild an atomic group with missing ASA opt-ins as the leading transactions.
 * Clears any existing group ID and reassigns so the opt-ins share the group.
 */
export function prependAssetOptInTransactions(
  encodedTransactions: string[],
  senderAddress: string,
  assetIds: number[],
): string[] {
  const uniqueAssetIds = [
    ...new Set(assetIds.filter((assetId) => assetId > 0)),
  ].sort((left, right) => left - right);
  if (uniqueAssetIds.length === 0 || encodedTransactions.length === 0) {
    return encodedTransactions;
  }

  const existing = encodedTransactions.map((encoded) =>
    algosdk.decodeUnsignedTransaction(Buffer.from(encoded, "base64")),
  );
  for (const transaction of existing) {
    transaction.group = undefined;
  }

  const template = existing[0]!;
  const suggestedParams = {
    fee: 1_000n,
    flatFee: true as const,
    firstValid: template.firstValid,
    lastValid: template.lastValid,
    genesisHash: template.genesisHash!,
    genesisID: template.genesisID ?? "",
    minFee: 1_000n,
  };

  const optIns = uniqueAssetIds.map((assetId) =>
    algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: senderAddress,
      receiver: senderAddress,
      amount: 0n,
      assetIndex: BigInt(assetId),
      suggestedParams,
    }),
  );

  const grouped = algosdk.assignGroupID([...optIns, ...existing]);
  if (grouped.length !== optIns.length + existing.length) {
    throw new Error("Failed to rebuild execution group with ASA opt-ins");
  }
  if (grouped.length > 16) {
    throw new Error(
      `Execution group with ASA opt-ins exceeds Algorand limit (${grouped.length} > 16)`,
    );
  }
  return grouped.map((transaction) =>
    Buffer.from(algosdk.encodeUnsignedTransaction(transaction)).toString(
      "base64",
    ),
  );
}

/** Per-shape inputs only: hints + required fields from the action, not the full deposit blob. */
export function buildShapeInput(
  shape: {
    shapeKey?: string;
    action?: string;
    variant?: string;
    requiredInputs: string[];
    inputHints?: Record<string, unknown>;
  },
  executionInput: Record<string, unknown>,
  maxSlippageBps: number,
): Record<string, unknown> {
  const required: Record<string, unknown> = {};
  for (const key of shape.requiredInputs) {
    if (key in executionInput) {
      required[key] = executionInput[key];
    }
  }
  const input: Record<string, unknown> = {
    ...(shape.inputHints ?? {}),
    ...required,
    maxSlippageBps,
  };
  return sanitizeFolksIdentifierFields(shape, input);
}

/**
 * Folks shapes reject sending both poolAppId and assetId. Prefer poolAppId
 * because USDC maps to multiple Folks pools and the gateway requires it.
 * Must not run for other protocols (e.g. Dork.fi requires both).
 */
export function sanitizeFolksIdentifierFields(
  shape: {
    shapeKey?: string;
    action?: string;
    variant?: string;
  },
  input: Record<string, unknown>,
): Record<string, unknown> {
  const shapeKey = shape.shapeKey ?? "";
  if (!/folks/i.test(shapeKey)) {
    return input;
  }
  const role = classifyFolksShape({
    shapeKey,
    protocol: "folks-finance",
    protocolVersion: "v2",
    action: shape.action ?? "unknown",
    variant: shape.variant ?? "unknown",
    title: "",
    summary: "",
    order: 0,
    requiredInputs: [],
    requiredAssetIds: [],
  });
  if (
    role !== "setup" &&
    role !== "opt" &&
    role !== "deposit"
  ) {
    return input;
  }
  const sanitized = { ...input };
  if (sanitized.poolAppId !== undefined && sanitized.assetId !== undefined) {
    delete sanitized.assetId;
  }
  return sanitized;
}

function readEscrowMetadata(metadata: Record<string, unknown> | undefined): {
  escrowAddress?: string;
  escrowPrivateKeyBase64?: string;
  depositsAppId?: number;
} | null {
  if (!metadata) {
    return null;
  }
  const escrowAddress =
    typeof metadata.escrowAddress === "string"
      ? metadata.escrowAddress
      : undefined;
  const escrowPrivateKeyBase64 =
    typeof metadata.escrowPrivateKeyBase64 === "string"
      ? metadata.escrowPrivateKeyBase64
      : undefined;
  const depositsAppId =
    typeof metadata.depositsAppId === "number"
      ? metadata.depositsAppId
      : undefined;
  if (!escrowAddress && !escrowPrivateKeyBase64) {
    return null;
  }
  return { escrowAddress, escrowPrivateKeyBase64, depositsAppId };
}

function secretKeyFromBase64(value: string): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (bytes.length === 64) {
    return bytes;
  }
  if (bytes.length === 32) {
    // Seed form — expand via algosdk account from mnemonic isn't available;
    // Folks returns full 64-byte sk. Reject unexpected 32-byte payloads.
    throw new Error(
      "Escrow key must be a 64-byte Algorand secret key (got 32-byte seed)",
    );
  }
  throw new Error(
    `Unexpected escrow secret key length ${bytes.length}; expected 64 bytes`,
  );
}

function isAccountAssetMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /asset|not found|404|no accounts/i.test(message);
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
  const transaction = algosdk.decodeUnsignedTransaction(
    Buffer.from(encodedTransaction, "base64"),
  );
  return signTransaction(transaction, secretKey);
}

function signTransaction(
  transaction: algosdk.Transaction,
  secretKey: Uint8Array,
): Uint8Array {
  return transaction.signTxn(secretKey);
}
