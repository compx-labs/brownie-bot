import { randomUUID } from "node:crypto";

import algosdk from "algosdk";
import { z } from "zod";

import type {
  ExecutionOutcome,
  Opportunity,
  OpportunityExecutionShape,
  PaymentReceipt,
  PortfolioAction,
  WalletClaimable,
} from "../../domain.js";
import type { Canix402Client } from "../canix402/client.js";
import type { TreasuryWallet } from "../canix402/wallet.js";
import type { FolksEscrowStore } from "./folks-escrow-store.js";
import {
  classifyFolksShape,
  FOLKS_GENERAL_LOAN_APP_ID,
  FOLKS_QUOTE_FORWARD_KEYS,
  needsSequentialEscrowExecution,
  resolveDepositAssetId,
  resolvePoolAppId,
  selectEscrowShapesToRun,
  sortExecutionShapes,
} from "./folks-execution.js";
import {
  alignQuotesByShapeKey,
  planClaimQuoteRequests,
  selectClaimQuoteRequests,
} from "../../services/claim-desk.js";

export { FOLKS_GENERAL_LOAN_APP_ID } from "./folks-execution.js";

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
  /**
   * Destination ASAs for which Haystack userPriceImpact may exceed
   * maxPriceImpactPct (preferred-hold accumulation into thin markets).
   */
  priceImpactExemptToAssetIds?: number[];
}

export interface ExecuteActionContext {
  opportunities?: Opportunity[];
  claimable?: WalletClaimable;
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
        : await this.executeShape(
            action,
            context.opportunities ?? [],
            context.claimable,
          );
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

  async executeClaimBatch(
    actions: PortfolioAction[],
    context: ExecuteActionContext = {},
  ): Promise<{
    outcomes: ExecutionOutcome[];
    payments: PaymentReceipt[];
  }> {
    if (actions.length === 0) {
      return { outcomes: [], payments: [] };
    }
    if (!this.policy.signingEnabled) {
      return {
        outcomes: actions.map((action) => ({
          actionId: action.id,
          status: "validated-dry-run",
        })),
        payments: [],
      };
    }
    const opportunities = context.opportunities ?? [];
    const plan = planClaimQuoteRequests(actions, context.claimable);
    const outcomesByAction = new Map<string, ExecutionOutcome>();
    for (const skipped of plan.skipped) {
      outcomesByAction.set(skipped.actionId, skipped);
    }
    const recordOutcome = (
      actionId: string,
      outcome: ExecutionOutcome,
    ): void => {
      const existing = outcomesByAction.get(actionId);
      if (existing?.status === "confirmed") {
        return;
      }
      outcomesByAction.set(actionId, { ...outcome, actionId });
    };
    const markRemaining = (
      actionIds: string[],
      error: string,
      status: "failed" | "skipped" = "skipped",
    ): void => {
      for (const actionId of actionIds) {
        if (!outcomesByAction.has(actionId)) {
          recordOutcome(actionId, { actionId, status, error });
        }
      }
    };

    if (plan.planned.length === 0) {
      return {
        outcomes: actions
          .filter((action) => outcomesByAction.has(action.id))
          .map((action) => outcomesByAction.get(action.id)!),
        payments: [],
      };
    }

    const actionsById = new Map(actions.map((action) => [action.id, action]));
    const extraSignersByAction = new Map<string, Map<string, Uint8Array>>();
    const receiveAssetIdsByAction = new Map<string, number[]>();
    const enrichedInputByAction = new Map<string, Record<string, unknown>>();
    for (const item of plan.planned) {
      const action = actionsById.get(item.actionId);
      if (!action) {
        continue;
      }
      const opportunity = action.opportunityId
        ? opportunities.find(
            (candidate) => candidate.opportunityId === action.opportunityId,
          )
        : undefined;
      let enriched = enrichedInputByAction.get(item.actionId);
      if (!enriched) {
        enriched = await this.enrichShapeExecutionInput(action, opportunity);
        enrichedInputByAction.set(item.actionId, enriched);
        extraSignersByAction.set(
          item.actionId,
          await this.folksExitExtraSigners(
            { ...action, executionInput: enriched },
            opportunity,
          ),
        );
        receiveAssetIdsByAction.set(
          item.actionId,
          collectPotentialReceiveAssetIds(action, opportunity),
        );
      }
      item.quote.input = { ...enriched, ...(item.quote.input ?? {}) };
    }

    let payments: PaymentReceipt[] = [];
    try {
      const result = await this.requestQuotes(
        actions.map((action) => action.id).join(","),
        plan.planned.map((item) => item.quote),
      );
      payments = result.payments;
      const aligned = alignQuotesByShapeKey(plan.planned, result.batch.data);
      for (const [index, { actionId, quote }] of aligned.entries()) {
        const action = actionsById.get(actionId) ?? actions[0]!;
        const remainingIds = aligned
          .slice(index + 1)
          .map((item) => item.actionId);
        try {
          const outcome = await this.submitQuotedTransactions(
            action,
            quote,
            extraSignersByAction.get(actionId) ?? new Map<string, Uint8Array>(),
            receiveAssetIdsByAction.get(actionId) ?? [],
            aligned.length === 1 ? actionId : `${actionId}:${index}`,
          );
          recordOutcome(actionId, outcome);
          if (outcome.status !== "confirmed") {
            markRemaining(
              remainingIds,
              "Claim batch stopped before this action",
            );
            break;
          }
        } catch (error) {
          recordOutcome(actionId, {
            actionId,
            status: "failed",
            error: formatExecutionError(error),
          });
          markRemaining(remainingIds, "Claim batch stopped before this action");
          break;
        }
      }
    } catch (error) {
      markRemaining(
        plan.planned.map((item) => item.actionId),
        formatExecutionError(error),
        "failed",
      );
    }

    return {
      outcomes: actions
        .filter((action) => outcomesByAction.has(action.id))
        .map((action) => outcomesByAction.get(action.id)!),
      payments,
    };
  }

  private async executeShape(
    action: PortfolioAction,
    opportunities: Opportunity[],
    claimable?: WalletClaimable,
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
    const clamped = await this.clampCapitalEnterToSpendable(action);
    if (
      opportunity &&
      ["open", "increase"].includes(clamped.type) &&
      needsSequentialEscrowExecution(opportunity.executionShapes)
    ) {
      return this.executeSequentialEscrowShapes(clamped, opportunity);
    }
    return this.executeBatchedShapes(clamped, opportunities, claimable);
  }

  /**
   * After swaps (or any fill shortfall), planned stake/deposit amounts can exceed
   * spendable balance. Clamp open/increase sizes to on-chain spendable before quoting.
   * Borrow shapes name the received asset in executionInput.assetId (e.g. DorkFi UNIT)
   * without spending it from the wallet — skip clamping for those.
   */
  private async clampCapitalEnterToSpendable(
    action: PortfolioAction,
  ): Promise<PortfolioAction> {
    if (!["open", "increase"].includes(action.type)) {
      return action;
    }
    if (/borrow/i.test(action.executionShapeKey ?? "")) {
      return action;
    }
    const assetId = resolveCapitalEnterSpendAssetId(action);
    if (assetId === null) {
      return action;
    }
    const spendableRaw = await this.readSpendableAssetRaw(assetId);
    const clamped = clampActionAmountToSpendable(action, {
      assetId,
      spendableRaw,
    });
    if (clamped !== action) {
      const planned = resolvePlannedSpendAmountRaw(action, assetId);
      console.error(
        `[execution] Clamped ${action.id} asset ${assetId} amount ${planned} → ${spendableRaw.toString()} (spendable after prior fills)`,
      );
    }
    if (
      spendableRaw === 0n &&
      resolvePlannedSpendAmountRaw(action, assetId) !== null
    ) {
      throw new Error(
        `Action ${action.id} needs asset ${assetId} but spendable balance is 0`,
      );
    }
    return clamped;
  }

  private async readSpendableAssetRaw(assetId: number): Promise<bigint> {
    if (assetId === 0) {
      const account = (await this.algod
        .accountInformation(this.managedAddress)
        .do()) as {
        amount: bigint | number;
        minBalance?: bigint | number;
      };
      const amount = BigInt(account.amount);
      const minimum = BigInt(account.minBalance ?? 0);
      return amount > minimum ? amount - minimum : 0n;
    }
    try {
      const info = (await this.algod
        .accountAssetInformation(this.managedAddress, assetId)
        .do()) as {
        assetHolding?: { amount?: bigint | number };
        amount?: bigint | number;
      };
      const raw = info.assetHolding?.amount ?? info.amount ?? 0;
      return BigInt(raw);
    } catch (error) {
      if (isAccountAssetMissing(error)) {
        return 0n;
      }
      throw error;
    }
  }

  private async executeBatchedShapes(
    action: PortfolioAction,
    opportunities: Opportunity[],
    claimable?: WalletClaimable,
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
    const deskQuotes =
      enrichedAction.type === "claim"
        ? selectClaimQuoteRequests([enrichedAction], claimable, () => []).map(
            (item) => item.quote,
          )
        : [];
    const quotes =
      deskQuotes.length > 0
        ? deskQuotes
        : buildQuoteRequests(
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

    const aligned = alignQuotesByShapeKey(
      quotes.map((quote) => ({
        actionId: enrichedAction.id,
        quote,
      })),
      batch.data,
    );
    for (const [index, { quote }] of aligned.entries()) {
      lastOutcome = await this.submitQuotedTransactions(
        enrichedAction,
        quote,
        extraSigners,
        receiveAssetIds,
        aligned.length === 1
          ? enrichedAction.id
          : `${enrichedAction.id}:${index}`,
      );
      if (lastOutcome.status !== "confirmed") {
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
      lastOutcome = await this.submitQuotedTransactions(
        action,
        quote,
        extraSigners,
        receiveAssetIds,
        stepLabel,
      );
      if (lastOutcome.status !== "confirmed") {
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

    if (["reduce", "close"].includes(action.type) && isFolksWithdraw) {
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
        const poolAppId = resolvePoolAppId(opportunity.executionShapes, input);
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

    // Folks loan-credit shapes: resolve loan escrowAddress from store when omitted.
    if (
      /folks/i.test(shapeKey) &&
      (/loanescrow|addcollateral|collateral:|borrow:|repay:/i.test(shapeKey) ||
        /borrow|repay|collateral/i.test(shapeKey)) &&
      typeof input.escrowAddress !== "string" &&
      this.folksEscrowStore
    ) {
      const loanAppId =
        typeof input.loanAppId === "number" && input.loanAppId > 0
          ? input.loanAppId
          : FOLKS_GENERAL_LOAN_APP_ID;
      const escrow = await this.folksEscrowStore.get(
        this.managedAddress,
        loanAppId,
      );
      if (escrow) {
        input.escrowAddress = escrow.escrowAddress;
        if (input.loanAppId === undefined) {
          input.loanAppId = loanAppId;
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
    if (!this.folksEscrowStore || !/folks/i.test(shapeKey)) {
      return signers;
    }
    // Deposit exits and loan credit shapes (setup/addCollateral/sync/borrow/repay)
    // all need the matching escrow secret when present in the store.
    const input = action.executionInput ?? {};
    const loanAppId =
      typeof input.loanAppId === "number" && input.loanAppId > 0
        ? input.loanAppId
        : undefined;
    const poolAppId = resolvePoolAppId(
      opportunity?.executionShapes ?? [],
      input,
    );
    for (const appId of [loanAppId, poolAppId]) {
      if (appId === undefined) {
        continue;
      }
      const escrow = await this.folksEscrowStore.get(
        this.managedAddress,
        appId,
      );
      if (escrow) {
        signers.set(
          escrow.escrowAddress,
          secretKeyFromBase64(escrow.escrowPrivateKeyBase64),
        );
      }
    }
    return signers;
  }

  private maybePatchFolksOracle(
    action: PortfolioAction,
    encodedTransactions: string[],
  ): string[] {
    const raw = action.executionInput?.[FOLKS_ORACLE_ASSET_IDS_INPUT_KEY];
    if (!Array.isArray(raw)) {
      return encodedTransactions;
    }
    const assetIds = raw.filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value) && value >= 0,
    );
    if (assetIds.length === 0) {
      return encodedTransactions;
    }
    return patchFolksOracleRefreshAssets(encodedTransactions, assetIds);
  }

  private async persistFolksEscrowFromQuoteMetadata(
    action: PortfolioAction,
    metadata: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (!this.folksEscrowStore) {
      return;
    }
    const meta = readEscrowMetadata(metadata);
    if (!meta?.escrowAddress || !meta.escrowPrivateKeyBase64) {
      return;
    }
    const input = action.executionInput ?? {};
    const shapeKey = action.executionShapeKey ?? "";
    const storeAppId =
      (typeof input.loanAppId === "number" && input.loanAppId > 0
        ? input.loanAppId
        : undefined) ??
      (typeof input.poolAppId === "number" && input.poolAppId > 0
        ? input.poolAppId
        : undefined) ??
      (/loanescrow/i.test(shapeKey) ? FOLKS_GENERAL_LOAN_APP_ID : undefined);
    if (storeAppId === undefined) {
      return;
    }
    await this.folksEscrowStore.save({
      walletAddress: this.managedAddress,
      poolAppId: storeAppId,
      depositsAppId: meta.depositsAppId,
      escrowAddress: meta.escrowAddress,
      escrowPrivateKeyBase64: meta.escrowPrivateKeyBase64,
    });
    console.error(
      `[execution] Persisted Folks escrow ${meta.escrowAddress} for app ${storeAppId}`,
    );
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

    let escrow = await this.folksEscrowStore.get(
      this.managedAddress,
      poolAppId,
    );
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
        .join(
          " → ",
        )} (escrow=${escrow ? "present" : "missing"}, opted=${escrowOptedIntoAsset})`,
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

  /**
   * Submit one compiled quote: opt in to missing receive ASAs (same group when
   * unsigned, a prior standalone group when any member is already signed),
   * attach Folks extra-signers, then sign/submit the claim group unmodified
   * when provider-cosigned.
   */
  private async submitQuotedTransactions(
    action: PortfolioAction,
    quote: z.infer<typeof executableQuoteSchema>,
    extraSigners: Map<string, Uint8Array>,
    receiveAssetIds: number[],
    stepLabel: string,
  ): Promise<ExecutionOutcome> {
    assertFresh(quote.expiresAt);
    const escrowSigners = folksEscrowSignersFromMetadata(quote.metadata);
    for (const [address, secret] of escrowSigners) {
      extraSigners.set(address, secret);
    }
    const prepared = await this.prepareGroupWithOptIns(
      stepLabel,
      quote.encodedTransactions,
      [
        ...receiveAssetIds,
        ...collectReceiveAssetIdsFromQuoteMetadata(quote.metadata),
      ],
    );
    if (prepared.optInOutcome && prepared.optInOutcome.status !== "confirmed") {
      return {
        ...prepared.optInOutcome,
        actionId: action.id,
        toolName: "canix_get_execution_quote",
      };
    }
    const encoded = encodedGroupHasSignedMember(prepared.encoded)
      ? prepared.encoded
      : this.maybePatchFolksOracle(action, prepared.encoded);
    const submit = await this.signAndSubmitEncoded(
      stepLabel,
      encoded,
      extraSigners,
    );
    if (submit.outcome.status === "confirmed") {
      await this.persistFolksEscrowFromQuoteMetadata(action, quote.metadata);
    }
    return {
      ...submit.outcome,
      actionId: action.id,
      toolName: "canix_get_execution_quote",
    };
  }

  private async prepareGroupWithOptIns(
    actionId: string,
    encodedTransactions: string[],
    assetIds: number[],
  ): Promise<{ encoded: string[]; optInOutcome?: ExecutionOutcome }> {
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
      return { encoded: encodedTransactions };
    }
    if (encodedGroupHasSignedMember(encodedTransactions)) {
      const optInEncoded = buildStandaloneAssetOptInTransactions(
        encodedTransactions,
        this.managedAddress,
        missing,
      );
      console.error(
        `[execution] Submitting standalone ASA opt-in(s) for asset(s) ${missing.join(", ")} before signed claim group`,
      );
      const optInSubmit = await this.signAndSubmitEncoded(
        `${actionId}:optin`,
        optInEncoded,
      );
      return {
        encoded: encodedTransactions,
        optInOutcome: optInSubmit.outcome,
      };
    }
    return {
      encoded: await this.withLeadingAssetOptIns(encodedTransactions, missing),
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
    const impactExempt = (
      this.policy.priceImpactExemptToAssetIds ?? []
    ).includes(action.toAssetId);
    if (
      !impactExempt &&
      (quote.data.userPriceImpact ?? 0) > this.policy.maxPriceImpactPct
    ) {
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
    // Canix loanEscrow quotes often fund the new escrow below Folks loan-app
    // MBR (~0.73 ALGO); bump only for loan-escrow setup groups.
    const fundedEncoded = /loanescrow|loan-escrow/i.test(actionId)
      ? bumpFolksLoanEscrowFunding(encodedTransactions, {
          funderAddress: this.managedAddress,
          escrowAddresses: [...extraSigners.keys()],
        })
      : encodedTransactions;
    const decodedMembers = fundedEncoded.map((encoded) =>
      decodeQuoteGroupMember(encoded),
    );
    const hasProviderSigned = decodedMembers.some(
      (member) => member.kind === "signed",
    );
    // Canix quotes are deterministic within a validity window; unique notes
    // keep retries/re-runs from colliding with already-confirmed txids.
    // Provider-cosigned groups (Tinyman Analytics farm claims) cannot be
    // regrouped; skip uniqueness notes when any member is already signed.
    const uniqueEncoded = hasProviderSigned
      ? null
      : applyUniqueTransactionNotes(fundedEncoded, actionId);
    const toSign = uniqueEncoded
      ? uniqueEncoded.map((encoded) => decodeQuoteGroupMember(encoded))
      : decodedMembers;
    const signed = toSign.map((member) => {
      if (member.kind === "signed") {
        return member.bytes;
      }
      const sender = member.transaction.sender.toString();
      if (sender === this.managedAddress) {
        return signTransaction(member.transaction, this.wallet.secretKey);
      }
      const escrowKey = extraSigners.get(sender);
      if (escrowKey) {
        return signTransaction(member.transaction, escrowKey);
      }
      throw new Error(
        `No signer available for transaction sender ${sender} in ${actionId}`,
      );
    });
    const submitted = (await this.algod.sendRawTransaction(signed).do()) as {
      txid: string;
    };
    const confirmation = await this.waitForSubmittedTransaction(submitted.txid);
    return {
      outcome: {
        actionId,
        status: "confirmed",
        transactionId: submitted.txid,
        confirmedRound: confirmation.confirmedRound?.toString(),
      },
    };
  }

  private async waitForSubmittedTransaction(txid: string) {
    return algosdk.waitForConfirmation(this.algod, txid, 8);
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
  const key =
    `${shape.shapeKey}:${shape.action}:${shape.variant}`.toLowerCase();
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
  const executionInput = stripHostOnlyExecutionInput(
    action.executionInput ?? {},
  );
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
      return isSetupOrPrerequisiteShape(shape) && shape.order <= target.order;
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
      input: sanitizeFolksIdentifierFields(
        {
          shapeKey: action.executionShapeKey ?? undefined,
          action: action.executionShapeKey?.split(":")[3],
          variant: action.executionShapeKey?.split(":")[4],
        },
        {
          ...executionInput,
          maxSlippageBps,
        },
      ),
    },
  ];
}

function stripHostOnlyExecutionInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...input };
  delete next[FOLKS_ORACLE_ASSET_IDS_INPUT_KEY];
  return next;
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
const NOTE_DECODER = new TextDecoder();

/** Optional host-only hint: Folks borrow/repay oracle must refresh these assets. */
export const FOLKS_ORACLE_ASSET_IDS_INPUT_KEY = "oracleAssetIds";

/**
 * Folks borrow/repay quotes from Canix often refresh only the borrow asset.
 * Collateral valuation still needs every collateral asset price in the same
 * group — merge required asset ids into the oracle adapter refresh_prices arg.
 */
export function patchFolksOracleRefreshAssets(
  encodedTransactions: string[],
  requiredAssetIds: number[],
): string[] {
  const required = [
    ...new Set(requiredAssetIds.filter((assetId) => assetId >= 0)),
  ].sort((left, right) => left - right);
  if (required.length === 0 || encodedTransactions.length === 0) {
    return encodedTransactions;
  }

  const REFRESH_PRICES_SELECTOR = "9524f1ff";
  let patched = false;
  const transactions = encodedTransactions.map((encoded) => {
    const transaction = algosdk.decodeUnsignedTransaction(
      Buffer.from(encoded, "base64"),
    );
    const mutable = transaction as algosdk.Transaction & {
      group?: Uint8Array;
    };
    mutable.group = undefined;
    const appArgs = transaction.applicationCall?.appArgs;
    if (!appArgs || appArgs.length < 3) {
      return transaction;
    }
    const selector = Buffer.from(appArgs[0]!).toString("hex");
    if (selector !== REFRESH_PRICES_SELECTOR) {
      return transaction;
    }
    const encodedAssets = Buffer.from(appArgs[2]!);
    if (encodedAssets.length < 2) {
      return transaction;
    }
    const count = encodedAssets.readUInt16BE(0);
    const existing: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const offset = 2 + index * 8;
      if (offset + 8 > encodedAssets.length) {
        break;
      }
      existing.push(Number(encodedAssets.readBigUInt64BE(offset)));
    }
    const merged = [...new Set([...existing, ...required])].sort(
      (left, right) => left - right,
    );
    if (
      merged.length === existing.length &&
      merged.every((assetId, index) => assetId === existing[index])
    ) {
      return transaction;
    }
    const rebuilt = Buffer.alloc(2 + merged.length * 8);
    rebuilt.writeUInt16BE(merged.length, 0);
    for (const [index, assetId] of merged.entries()) {
      rebuilt.writeBigUInt64BE(BigInt(assetId), 2 + index * 8);
    }
    const nextArgs = [...appArgs];
    nextArgs[2] = new Uint8Array(rebuilt);
    (
      transaction.applicationCall as unknown as {
        appArgs: Uint8Array[];
      }
    ).appArgs = nextArgs;
    patched = true;
    return transaction;
  });

  if (!patched) {
    return encodedTransactions;
  }
  console.error(
    `[execution] Patched Folks oracle refresh assets → [${required.join(", ")}]`,
  );
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

/**
 * Folks loan escrow creation needs ~0.73 ALGO MBR on the new escrow after
 * loan-app opt-in. Canix has been quoting a 0.25 ALGO fund payment; raise it.
 */
export const FOLKS_LOAN_ESCROW_MIN_FUND_MICROALGOS = 1_000_000n;

export function bumpFolksLoanEscrowFunding(
  encodedTransactions: string[],
  options: {
    funderAddress: string;
    escrowAddresses: string[];
    minFundMicroAlgos?: bigint;
  },
): string[] {
  const escrowSet = new Set(options.escrowAddresses);
  if (escrowSet.size === 0 || encodedTransactions.length === 0) {
    return encodedTransactions;
  }
  const minFund =
    options.minFundMicroAlgos ?? FOLKS_LOAN_ESCROW_MIN_FUND_MICROALGOS;
  let bumped = false;
  const transactions = encodedTransactions.map((encoded) => {
    const transaction = algosdk.decodeUnsignedTransaction(
      Buffer.from(encoded, "base64"),
    );
    const mutable = transaction as algosdk.Transaction & {
      group?: Uint8Array;
    };
    mutable.group = undefined;
    if (!transaction.payment) {
      return transaction;
    }
    const sender = transaction.sender.toString();
    const receiver = transaction.payment.receiver.toString();
    const amount = BigInt(transaction.payment.amount);
    if (
      sender === options.funderAddress &&
      escrowSet.has(receiver) &&
      amount > 0n &&
      amount < minFund
    ) {
      bumped = true;
      return algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: options.funderAddress,
        receiver,
        amount: minFund,
        note: transaction.note,
        rekeyTo: transaction.rekeyTo,
        closeRemainderTo: transaction.payment.closeRemainderTo,
        suggestedParams: {
          fee: transaction.fee,
          flatFee: true,
          firstValid: transaction.firstValid,
          lastValid: transaction.lastValid,
          genesisHash: transaction.genesisHash,
          genesisID: transaction.genesisID,
          minFee: transaction.fee,
        },
      });
    }
    return transaction;
  });
  if (!bumped) {
    return encodedTransactions;
  }
  console.error(
    `[execution] Bumped Folks loan escrow funding to ${minFund.toString()} microAlgos`,
  );
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

/**
 * Folks escrow-binding payments use note = ASCII prefix (e.g. "la ", "da ") +
 * 32-byte escrow public key (exactly 35 bytes). Appending a uniqueness suffix
 * breaks on-chain assert equality — leave these notes untouched.
 */
export function isFolksEscrowBindingNote(
  note: Uint8Array | undefined,
): boolean {
  if (!note || note.length !== 35) {
    return false;
  }
  const prefix = NOTE_DECODER.decode(note.subarray(0, 3));
  return /^[a-z]{2} $/.test(prefix);
}

/**
 * Stamp a per-submit nonce onto each transaction note and rebuild the group.
 * Canix execution quotes are deterministic for identical inputs within a validity
 * window; without unique notes, retries collide with already-confirmed txids
 * ("transaction already in ledger").
 *
 * Existing notes are preserved as a prefix (protocol-required note prefixes keep
 * working) and a `|brownie|<actionId>|<nonce>|<index>` suffix is appended.
 * Folks escrow-binding notes are left unchanged (exact 35-byte match required).
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
    if (!isFolksEscrowBindingNote(transaction.note)) {
      mutable.note = buildUniqueNote(transaction.note, actionId, nonce, index);
    }
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
  if (encodedGroupHasSignedMember(encodedTransactions)) {
    throw new Error(
      "Cannot prepend ASA opt-ins onto a provider-signed execution group",
    );
  }
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

export function encodedGroupHasSignedMember(
  encodedTransactions: string[],
): boolean {
  return encodedTransactions.some((encoded) => {
    try {
      return decodeQuoteGroupMember(encoded).kind === "signed";
    } catch {
      return false;
    }
  });
}

/**
 * Unsigned self opt-in group using the quoted group's validity window.
 * Used when the claim group already has provider signatures and must not be
 * regrouped.
 */
export function buildStandaloneAssetOptInTransactions(
  encodedTransactions: string[],
  senderAddress: string,
  assetIds: number[],
): string[] {
  const uniqueAssetIds = [
    ...new Set(assetIds.filter((assetId) => assetId > 0)),
  ].sort((left, right) => left - right);
  if (uniqueAssetIds.length === 0 || encodedTransactions.length === 0) {
    return [];
  }
  const template = transactionFromEncodedMember(encodedTransactions[0]!);
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
  const grouped = optIns.length === 1 ? optIns : algosdk.assignGroupID(optIns);
  return grouped.map((transaction) =>
    Buffer.from(algosdk.encodeUnsignedTransaction(transaction)).toString(
      "base64",
    ),
  );
}

function transactionFromEncodedMember(encoded: string): algosdk.Transaction {
  const member = decodeQuoteGroupMember(encoded);
  if (member.kind === "unsigned") {
    return member.transaction;
  }
  return algosdk.decodeSignedTransaction(Buffer.from(encoded, "base64")).txn;
}

/**
 * Asset whose planned deposit/stake amount may overshoot after a prior swap fill.
 * Prefer explicit executionInput.assetId, else a single authorizedSpend, else fromAssetId.
 */
export function resolveCapitalEnterSpendAssetId(
  action: PortfolioAction,
): number | null {
  const input = action.executionInput ?? {};
  if (typeof input.assetId === "number" && Number.isInteger(input.assetId)) {
    return input.assetId;
  }
  if (action.authorizedSpends.length === 1) {
    return action.authorizedSpends[0]!.assetId;
  }
  if (action.fromAssetId !== null) {
    return action.fromAssetId;
  }
  return null;
}

/** Planned raw amount for a spend asset from amountRaw / authorizedSpends / executionInput.amount. */
export function resolvePlannedSpendAmountRaw(
  action: PortfolioAction,
  assetId: number,
): string | null {
  const spend = action.authorizedSpends.find(
    (candidate) => candidate.assetId === assetId,
  );
  if (spend) {
    return spend.amountRaw;
  }
  if (
    action.amountRaw !== null &&
    (action.fromAssetId === assetId ||
      (action.executionInput && action.executionInput.assetId === assetId))
  ) {
    return action.amountRaw;
  }
  const inputAmount = action.executionInput?.amount;
  if (typeof inputAmount === "string" && /^[0-9]+$/.test(inputAmount)) {
    return inputAmount;
  }
  if (
    typeof inputAmount === "number" &&
    Number.isInteger(inputAmount) &&
    inputAmount >= 0
  ) {
    return String(inputAmount);
  }
  return null;
}

/**
 * Shrink open/increase sizes so they never exceed on-chain spendable for the
 * spend asset (e.g. stake amount after a swap filled short of the quote).
 */
export function clampActionAmountToSpendable(
  action: PortfolioAction,
  options: { assetId: number; spendableRaw: bigint },
): PortfolioAction {
  const { assetId, spendableRaw } = options;
  if (spendableRaw < 0n) {
    throw new Error(
      `Spendable balance for asset ${assetId} cannot be negative`,
    );
  }
  const planned = resolvePlannedSpendAmountRaw(action, assetId);
  if (planned === null) {
    return action;
  }
  let plannedRaw: bigint;
  try {
    plannedRaw = BigInt(planned);
  } catch {
    return action;
  }
  if (plannedRaw <= spendableRaw) {
    return action;
  }
  if (spendableRaw === 0n) {
    return action;
  }
  const clamped = spendableRaw.toString();
  const executionInput = { ...(action.executionInput ?? {}) };
  for (const [key, value] of Object.entries(executionInput)) {
    if (!/amount/i.test(key)) {
      continue;
    }
    const asString =
      typeof value === "string"
        ? value
        : typeof value === "number" && Number.isInteger(value)
          ? String(value)
          : null;
    if (asString === planned) {
      executionInput[key] = clamped;
    }
  }
  if (
    typeof executionInput.amount === "undefined" &&
    action.amountRaw === planned
  ) {
    executionInput.amount = clamped;
  }
  return {
    ...action,
    amountRaw: action.amountRaw === planned ? clamped : action.amountRaw,
    authorizedSpends: action.authorizedSpends.map((spend) =>
      spend.assetId === assetId && spend.amountRaw === planned
        ? { ...spend, amountRaw: clamped }
        : spend,
    ),
    executionInput:
      Object.keys(executionInput).length > 0
        ? executionInput
        : action.executionInput,
  };
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
  // Folks credit shapes list a short requiredInputs set; poolAppId / loanAppId /
  // amounts still need to reach Canix when the runner supplies them.
  const folksForward: Record<string, unknown> = {};
  if (/folks/i.test(shape.shapeKey ?? "")) {
    for (const key of FOLKS_QUOTE_FORWARD_KEYS) {
      if (key in executionInput && executionInput[key] !== undefined) {
        folksForward[key] = executionInput[key];
      }
    }
  }
  const input: Record<string, unknown> = {
    ...(shape.inputHints ?? {}),
    ...folksForward,
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
  if (role !== "setup" && role !== "opt" && role !== "deposit") {
    // Borrow/repay/collateral quotes also reject poolAppId + assetId together.
    const sanitizedCredit = { ...input };
    if (
      sanitizedCredit.poolAppId !== undefined &&
      sanitizedCredit.assetId !== undefined
    ) {
      delete sanitizedCredit.assetId;
    }
    return sanitizedCredit;
  }
  const sanitized = { ...input };
  if (sanitized.poolAppId !== undefined && sanitized.assetId !== undefined) {
    delete sanitized.assetId;
  }
  return sanitized;
}

function folksEscrowSignersFromMetadata(
  metadata: Record<string, unknown> | undefined,
): Map<string, Uint8Array> {
  const signers = new Map<string, Uint8Array>();
  const meta = readEscrowMetadata(metadata);
  if (!meta?.escrowAddress || !meta.escrowPrivateKeyBase64) {
    return signers;
  }
  signers.set(
    meta.escrowAddress,
    secretKeyFromBase64(meta.escrowPrivateKeyBase64),
  );
  return signers;
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

function decodeQuoteGroupMember(
  encoded: string,
):
  | { kind: "unsigned"; transaction: algosdk.Transaction }
  | { kind: "signed"; bytes: Uint8Array } {
  const bytes = Buffer.from(encoded, "base64");
  try {
    return {
      kind: "unsigned",
      transaction: algosdk.decodeUnsignedTransaction(bytes),
    };
  } catch {
    algosdk.decodeSignedTransaction(bytes);
    return { kind: "signed", bytes: new Uint8Array(bytes) };
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
