import algosdk from "algosdk";
import { z } from "zod";

import type {
  ExecutionOutcome,
  PaymentReceipt,
  PortfolioAction,
} from "../../domain.js";
import type { Canix402Client } from "../canix402/client.js";
import type { TreasuryWallet } from "../canix402/wallet.js";

const executionQuoteSchema = z.object({
  data: z.object({
    shapeKey: z.string(),
    expiresAt: z.iso.datetime(),
    encodedTransactions: z.array(z.string().min(1)).min(1),
    warnings: z.array(z.string()).default([]),
    transactions: z.array(z.unknown()).default([]),
  }),
  meta: z.object({
    executionSubmitted: z.literal(false),
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

const MAINNET_GENESIS_HASH = Buffer.from(
  "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
  "base64",
);
const MAX_ATOMIC_GROUP_SIZE = 16;
const MAX_VALIDITY_WINDOW_ROUNDS = 1_000n;

export interface ExecutionPolicy {
  signingEnabled: boolean;
  maxFeeMicroAlgos: bigint;
  maxSlippageBps: number;
  maxPriceImpactPct: number;
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

  async executeAction(action: PortfolioAction): Promise<{
    outcome: ExecutionOutcome;
    payments: PaymentReceipt[];
  }> {
    if (action.type === "hold") {
      return {
        outcome: { actionId: action.id, status: "skipped" },
        payments: [],
      };
    }
    try {
      return action.type === "swap"
        ? await this.executeSwap(action)
        : await this.executeShape(action);
    } catch (error) {
      return {
        outcome: {
          actionId: action.id,
          status: "failed",
          error:
            error instanceof Error ? error.message : "Unknown execution error",
        },
        payments: [],
      };
    }
  }

  private async executeShape(action: PortfolioAction): Promise<{
    outcome: ExecutionOutcome;
    payments: PaymentReceipt[];
  }> {
    if (!action.executionShapeKey || !action.executionInput) {
      throw new Error(`Action ${action.id} has no execution shape`);
    }
    const result = await this.canix.callManagedTool(
      "canix_get_execution_quote",
      {
        shapeKey: action.executionShapeKey,
        input: {
          ...action.executionInput,
          maxSlippageBps: this.policy.maxSlippageBps,
        },
      },
      this.managedAddress,
    );
    const quote = executionQuoteSchema.parse(result.data);
    assertFresh(quote.data.expiresAt);
    const blobs = quote.data.encodedTransactions.map((encoded) => ({
      encoded,
      signer: "user" as const,
    }));
    const outcome = await this.validateSignAndSubmit(
      action.id,
      blobs,
      (transactions) =>
        assertActionSpends(transactions, this.managedAddress, action),
    );
    return {
      outcome: {
        ...outcome.outcome,
        toolName: "canix_get_execution_quote",
      },
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
    const fromAssetId = action.fromAssetId;
    const amountRaw = action.amountRaw;
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
      const optInOutcome = await this.validateSignAndSubmit(
        `${action.id}:optin`,
        optIn.data.transactions.map((transaction) => ({
          encoded: transaction.encodedTransaction,
          signer: "user" as const,
        })),
        (transactions) =>
          assertOptInTransactions(transactions, this.managedAddress),
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
    assertOrderedGroup(group.data.transactions);
    const userIndexes = new Set(group.data.userSignIndexes);
    for (const transaction of group.data.transactions) {
      if (
        (transaction.signer === "user") !==
        userIndexes.has(transaction.index)
      ) {
        throw new Error(
          "Haystack userSignIndexes do not match signer metadata",
        );
      }
    }
    const outcome = await this.validateSignAndSubmit(
      action.id,
      group.data.transactions.map((transaction) => ({
        encoded: transaction.encodedTransaction,
        signer: transaction.signer,
        signed: transaction.signedTransaction,
      })),
      (transactions) =>
        assertSwapSpend(
          transactions,
          this.managedAddress,
          fromAssetId,
          BigInt(amountRaw),
        ),
    );
    return {
      outcome: { ...outcome.outcome, toolName: "canix_swap" },
      payments: swapResult.payment ? [swapResult.payment] : [],
    };
  }

  private async validateSignAndSubmit(
    actionId: string,
    members: Array<{
      encoded: string;
      signer: "user" | "haystack";
      signed?: string;
    }>,
    validateTransactions?: (transactions: algosdk.Transaction[]) => void,
  ): Promise<{
    outcome: ExecutionOutcome;
    transactions: algosdk.Transaction[];
  }> {
    if (members.length > MAX_ATOMIC_GROUP_SIZE) {
      throw new Error(
        `Transaction group contains more than ${MAX_ATOMIC_GROUP_SIZE} members`,
      );
    }
    const decoded = members.map((member) => {
      const transaction = algosdk.decodeUnsignedTransaction(
        Buffer.from(member.encoded, "base64"),
      );
      const sender = transaction.sender.toString();
      const fee = BigInt(transaction.fee);
      if (fee > this.policy.maxFeeMicroAlgos) {
        throw new Error(`Transaction fee ${fee} exceeds policy`);
      }
      if (member.signer === "user" && sender !== this.managedAddress) {
        throw new Error(`Unexpected local transaction sender ${sender}`);
      }
      if (member.signer === "haystack" && !member.signed) {
        throw new Error(
          "Haystack transaction is missing its provider signature",
        );
      }
      assertSafeTransaction(transaction);
      return transaction;
    });
    assertGroupIds(decoded);
    validateTransactions?.(decoded);
    const totalFee = decoded.reduce(
      (total, transaction) => total + transaction.fee,
      0n,
    );
    if (totalFee > this.policy.maxFeeMicroAlgos) {
      throw new Error(`Transaction group fee ${totalFee} exceeds policy`);
    }
    const providerBlobs = members.map((member, index) => {
      if (member.signer === "user") {
        return undefined;
      }
      const blob = Buffer.from(member.signed ?? "", "base64");
      const providerSigned = algosdk.decodeSignedTransaction(blob);
      if (providerSigned.txn.txID() !== decoded[index]?.txID()) {
        throw new Error("Haystack signature does not match transaction bytes");
      }
      return new Uint8Array(blob);
    });
    if (!this.policy.signingEnabled) {
      return {
        outcome: { actionId, status: "validated-dry-run" },
        transactions: decoded,
      };
    }
    const signed = members.map((member, index) => {
      const transaction = decoded[index];
      if (!transaction) {
        throw new Error("Transaction group index mismatch");
      }
      if (member.signer === "user") {
        return transaction.signTxn(this.wallet.secretKey);
      }
      const providerBlob = providerBlobs[index];
      if (!providerBlob) {
        throw new Error("Haystack signed transaction index mismatch");
      }
      return providerBlob;
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
      transactions: decoded,
    };
  }
}

function assertFresh(expiresAt: string): void {
  if (new Date(expiresAt).getTime() <= Date.now() + 2_000) {
    throw new Error("Execution quote is expired or too close to expiry");
  }
}

function assertOrderedGroup(transactions: Array<{ index: number }>): void {
  transactions.forEach((transaction, index) => {
    if (transaction.index !== index) {
      throw new Error("Transaction group order is invalid");
    }
  });
}

function assertGroupIds(transactions: algosdk.Transaction[]): void {
  if (transactions.length <= 1) {
    return;
  }
  const groups = transactions.map((transaction) =>
    transaction.group ? Buffer.from(transaction.group).toString("base64") : "",
  );
  if (!groups[0] || groups.some((group) => group !== groups[0])) {
    throw new Error("Transactions do not share one atomic group ID");
  }
}

function assertSafeTransaction(transaction: algosdk.Transaction): void {
  if (
    !["pay", "axfer", "appl"].includes(transaction.type) ||
    transaction.rekeyTo ||
    transaction.payment?.closeRemainderTo ||
    transaction.assetTransfer?.closeRemainderTo ||
    transaction.assetTransfer?.assetSender
  ) {
    throw new Error(`Unsafe transaction ${transaction.txID()} was rejected`);
  }
  if (
    !transaction.genesisHash ||
    !Buffer.from(transaction.genesisHash).equals(MAINNET_GENESIS_HASH)
  ) {
    throw new Error("Transaction is not bound to Algorand mainnet");
  }
  if (
    transaction.lastValid < transaction.firstValid ||
    transaction.lastValid - transaction.firstValid > MAX_VALIDITY_WINDOW_ROUNDS
  ) {
    throw new Error("Transaction validity window exceeds policy");
  }
}

function assertSwapSpend(
  transactions: algosdk.Transaction[],
  walletAddress: string,
  fromAssetId: number,
  expectedAmount: bigint,
): void {
  const spends = transactions.filter(
    (transaction) =>
      transaction.sender.toString() === walletAddress &&
      (fromAssetId === 0
        ? transaction.payment?.amount === expectedAmount
        : transaction.assetTransfer?.assetIndex === BigInt(fromAssetId) &&
          transaction.assetTransfer.amount === expectedAmount),
  );
  if (spends.length !== 1) {
    throw new Error(
      "Swap group does not contain exactly one matching treasury input",
    );
  }
}

function assertActionSpends(
  transactions: algosdk.Transaction[],
  walletAddress: string,
  action: PortfolioAction,
): void {
  const positiveSpends = transactions.filter((transaction) => {
    if (transaction.sender.toString() !== walletAddress) {
      return false;
    }
    return (
      (transaction.payment?.amount ?? 0n) > 0n ||
      (transaction.assetTransfer?.amount ?? 0n) > 0n
    );
  });
  const actual = new Map<number, bigint>();
  for (const transaction of positiveSpends) {
    const assetId = transaction.payment
      ? 0
      : Number(transaction.assetTransfer?.assetIndex);
    const amount =
      transaction.payment?.amount ?? transaction.assetTransfer?.amount ?? 0n;
    actual.set(assetId, (actual.get(assetId) ?? 0n) + amount);
  }
  const authorized = new Map(
    action.authorizedSpends.map((spend) => [
      spend.assetId,
      BigInt(spend.amountRaw),
    ]),
  );
  if (
    actual.size !== authorized.size ||
    [...authorized].some(([assetId, amount]) => actual.get(assetId) !== amount)
  ) {
    throw new Error(
      `Action ${action.id} transaction spend does not match its approved amount`,
    );
  }
}

function assertOptInTransactions(
  transactions: algosdk.Transaction[],
  walletAddress: string,
): void {
  for (const transaction of transactions) {
    const validAssetOptIn =
      transaction.assetTransfer?.amount === 0n &&
      transaction.assetTransfer.receiver.toString() === walletAddress;
    const validApplicationOptIn =
      transaction.applicationCall?.onComplete ===
      algosdk.OnApplicationComplete.OptInOC;
    if (!validAssetOptIn && !validApplicationOptIn) {
      throw new Error("Opt-in group contains a non-opt-in transaction");
    }
  }
}
