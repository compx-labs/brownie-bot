import { randomUUID } from "node:crypto";

import algosdk from "algosdk";
import { z } from "zod";

import type { PaymentReceipt } from "../../domain.js";
import type { TreasuryWallet } from "./wallet.js";

const acceptSchema = z
  .object({
    scheme: z.literal("exact"),
    network: z.string().min(1),
    asset: z.union([z.string(), z.number()]).transform(String),
    amount: z.union([z.string(), z.number()]).optional(),
    maxAmountRequired: z.union([z.string(), z.number()]).optional(),
    payTo: z.string().min(1),
    maxTimeoutSeconds: z.number().optional(),
    extra: z
      .object({
        feePayer: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const paymentRequestSchema = z
  .object({
    x402Version: z.number().int(),
    resource: z
      .object({
        url: z.url(),
      })
      .passthrough(),
    accepts: z.array(acceptSchema).min(1),
    extensions: z.record(z.string(), z.unknown()).optional(),
    outputSchema: z.unknown().optional(),
  })
  .passthrough();

export type PaymentRequest = z.infer<typeof paymentRequestSchema>;

const ALGORAND_MAINNET_NETWORK =
  "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const MAINNET_USDC_ASSET_ID = "31566704";
const CANIX402_API_ORIGIN = "https://canix402-api.compx.io";
const ENDPOINT_CEILINGS = new Map([
  ["/opportunities", 10_000n],
  ["/opportunities/search", 10_000n],
  ["/opportunities/personalized", 50_000n],
  ["/positions", 5_000n],
  ["/execution/quotes", 100_000n],
  ["/swaps/transactions", 5_000n],
]);

export interface PaymentPolicy {
  algodUrl: string;
  maxDailyBaseUnits?: bigint;
  /** Test seam; production fetches fresh params from algod. */
  getSuggestedParams?: () => Promise<algosdk.SuggestedParams>;
}

export interface BuiltPayment {
  paymentSignature: string;
  receipt: PaymentReceipt;
}

export interface PaymentBuilder {
  build(request: unknown): Promise<BuiltPayment>;
}

export class AlgorandPaymentBuilder implements PaymentBuilder {
  private spentToday = 0n;
  private spendDate = new Date().toISOString().slice(0, 10);

  constructor(
    private readonly wallet: TreasuryWallet,
    private readonly policy: PaymentPolicy,
  ) {}

  async build(rawRequest: unknown): Promise<BuiltPayment> {
    const paymentRequest = paymentRequestSchema.parse(rawRequest);
    if (paymentRequest.x402Version !== 2) {
      throw new Error(`Unsupported x402 version ${paymentRequest.x402Version}`);
    }

    const accepted = paymentRequest.accepts.find(
      (candidate) =>
        candidate.network === ALGORAND_MAINNET_NETWORK &&
        candidate.asset === MAINNET_USDC_ASSET_ID,
    );
    if (!accepted) {
      throw new Error("No approved Algorand USDC payment option was offered");
    }

    const resourceUrl = new URL(paymentRequest.resource.url);
    if (resourceUrl.origin !== CANIX402_API_ORIGIN) {
      throw new Error(`Unexpected x402 resource origin ${resourceUrl.origin}`);
    }
    const endpointCeiling =
      ENDPOINT_CEILINGS.get(resourceUrl.pathname) ??
      (resourceUrl.pathname.startsWith("/protocols/") &&
      resourceUrl.pathname.endsWith("/opportunities")
        ? 10_000n
        : undefined);
    if (endpointCeiling === undefined) {
      throw new Error(
        `Unsupported paid Canix402 resource ${resourceUrl.pathname}`,
      );
    }

    if (!algosdk.isValidAddress(accepted.payTo)) {
      throw new Error("x402 payTo is not a valid Algorand address");
    }
    if (
      accepted.extra?.feePayer &&
      !algosdk.isValidAddress(accepted.extra.feePayer)
    ) {
      throw new Error("x402 feePayer is not a valid Algorand address");
    }

    const amountValue = accepted.maxAmountRequired ?? accepted.amount;
    if (amountValue === undefined) {
      throw new Error("x402 payment requirement has no amount");
    }
    const amount = BigInt(amountValue);
    if (amount <= 0n || amount > endpointCeiling) {
      throw new Error(
        `x402 payment ${amount.toString()} exceeds the ${resourceUrl.pathname} endpoint ceiling`,
      );
    }
    this.resetDailySpendIfNeeded();
    const dailyLimit = this.policy.maxDailyBaseUnits ?? 500_000n;
    if (this.spentToday + amount > dailyLimit) {
      throw new Error(
        `x402 daily spend would exceed ${dailyLimit.toString()} base units`,
      );
    }

    const suggestedParams = await this.loadSuggestedParams();
    const paymentNonce = randomUUID();
    const transfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: this.wallet.address,
      receiver: accepted.payTo,
      amount,
      assetIndex: BigInt(accepted.asset),
      note: encodePaymentNote(resourceUrl.pathname, paymentNonce),
      suggestedParams: {
        ...suggestedParams,
        flatFee: true,
        fee: accepted.extra?.feePayer ? 0n : 1_000n,
      },
    });

    let paymentGroup: string[];
    let paymentIndex: number;
    if (accepted.extra?.feePayer) {
      const feeTransaction =
        algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          sender: accepted.extra.feePayer,
          receiver: accepted.extra.feePayer,
          amount: 0n,
          note: encodeFeePayerNote(resourceUrl.pathname, paymentNonce),
          suggestedParams: {
            ...suggestedParams,
            flatFee: true,
            fee: 2_000n,
          },
        });
      const [groupedFee, groupedTransfer] = algosdk.assignGroupID([
        feeTransaction,
        transfer,
      ]);
      if (!groupedFee || !groupedTransfer) {
        throw new Error("Failed to construct x402 payment group");
      }
      paymentGroup = [
        Buffer.from(algosdk.encodeUnsignedTransaction(groupedFee)).toString(
          "base64",
        ),
        Buffer.from(groupedTransfer.signTxn(this.wallet.secretKey)).toString(
          "base64",
        ),
      ];
      paymentIndex = 1;
    } else {
      paymentGroup = [
        Buffer.from(transfer.signTxn(this.wallet.secretKey)).toString("base64"),
      ];
      paymentIndex = 0;
    }

    const normalizedAccepted = {
      ...accepted,
      amount: amount.toString(),
    };
    const envelope = {
      x402Version: paymentRequest.x402Version,
      scheme: accepted.scheme,
      network: accepted.network,
      resource: paymentRequest.resource,
      accepted: normalizedAccepted,
      extensions: paymentRequest.extensions ?? {},
      outputSchema: paymentRequest.outputSchema ?? null,
      payload: { paymentGroup, paymentIndex },
      paymentRequired: paymentRequest,
    };

    this.spentToday += amount;
    return {
      paymentSignature: Buffer.from(JSON.stringify(envelope)).toString(
        "base64",
      ),
      receipt: {
        amountBaseUnits: amount.toString(),
        assetId: accepted.asset,
        network: accepted.network,
        resourcePath: resourceUrl.pathname,
      },
    };
  }

  private async loadSuggestedParams(): Promise<algosdk.SuggestedParams> {
    if (this.policy.getSuggestedParams) {
      return this.policy.getSuggestedParams();
    }
    const algod = new algosdk.Algodv2("", this.policy.algodUrl, "");
    return algod.getTransactionParams().do();
  }

  private resetDailySpendIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.spendDate) {
      this.spendDate = today;
      this.spentToday = 0n;
    }
  }
}

/** Unique note so concurrent identical-price x402 payments do not collide. */
export function encodePaymentNote(
  resourcePath: string,
  nonce: string,
): Uint8Array {
  return new TextEncoder().encode(`x402-payment-v2|${resourcePath}|${nonce}`);
}

export function encodeFeePayerNote(
  resourcePath: string,
  nonce: string,
): Uint8Array {
  return new TextEncoder().encode(`x402-fee-payer|${resourcePath}|${nonce}`);
}
