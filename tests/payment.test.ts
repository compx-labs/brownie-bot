import algosdk from "algosdk";
import { describe, expect, it } from "vitest";

import {
  AlgorandPaymentBuilder,
  encodePaymentNote,
} from "../src/integrations/canix402/payment.js";
import { walletFromMnemonic } from "../src/integrations/canix402/wallet.js";

const network = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";

const fixedSuggestedParams = {
  fee: 1_000n,
  flatFee: false,
  firstValid: 1_000n,
  lastValid: 2_000n,
  genesisID: "mainnet-v1.0",
  genesisHash: new Uint8Array(32).fill(1),
  minFee: 1_000n,
} as algosdk.SuggestedParams;

function builder(
  overrides: {
    getSuggestedParams?: () => Promise<algosdk.SuggestedParams>;
  } = {},
) {
  const walletAccount = algosdk.generateAccount();
  const wallet = walletFromMnemonic(
    algosdk.secretKeyToMnemonic(walletAccount.sk),
  );
  return new AlgorandPaymentBuilder(wallet, {
    algodUrl: "https://mainnet-api.algonode.cloud",
    ...overrides,
  });
}

function signedPaymentTxId(paymentSignature: string): string {
  const envelope = JSON.parse(
    Buffer.from(paymentSignature, "base64").toString("utf8"),
  ) as {
    payload: { paymentGroup: string[]; paymentIndex: number };
  };
  const signed = Buffer.from(
    envelope.payload.paymentGroup[envelope.payload.paymentIndex]!,
    "base64",
  );
  return algosdk.decodeSignedTransaction(signed).txn.txID();
}

function paymentRequest(amount: string, path = "/opportunities/personalized") {
  return {
    x402Version: 2,
    resource: {
      url: `https://canix402-api.compx.io${path}`,
    },
    accepts: [
      {
        scheme: "exact",
        network,
        asset: "31566704",
        amount,
        payTo: algosdk.generateAccount().addr.toString(),
      },
    ],
  };
}

describe("AlgorandPaymentBuilder guardrails", () => {
  it("rejects a payment above the endpoint base-unit ceiling", async () => {
    await expect(builder().build(paymentRequest("50001"))).rejects.toThrow(
      /opportunities\/personalized endpoint ceiling/,
    );
    await expect(
      builder().build(paymentRequest("10001", "/opportunities")),
    ).rejects.toThrow(/opportunities endpoint ceiling/);
  });

  it("rejects an unexpected resource origin before signing", async () => {
    const request = paymentRequest("50000");
    request.resource.url = "https://attacker.example/opportunities";
    await expect(builder().build(request)).rejects.toThrow(
      /Unexpected x402 resource origin/,
    );
  });

  it("builds unique payment notes for the same resource and amount", () => {
    const left = new TextDecoder().decode(
      encodePaymentNote("/protocols/tinyman/opportunities", "nonce-a"),
    );
    const right = new TextDecoder().decode(
      encodePaymentNote("/protocols/tinyman/opportunities", "nonce-b"),
    );
    expect(left).toContain("x402-payment-v2|/protocols/tinyman/opportunities|");
    expect(left).not.toBe(right);
  });

  it("produces distinct txids for concurrent identical-price payments", async () => {
    const payTo = algosdk.generateAccount().addr.toString();
    const payments = builder({
      getSuggestedParams: () => Promise.resolve(fixedSuggestedParams),
    });
    const request = {
      x402Version: 2,
      resource: {
        url: "https://canix402-api.compx.io/protocols/tinyman/opportunities",
      },
      accepts: [
        {
          scheme: "exact" as const,
          network,
          asset: "31566704",
          amount: "10000",
          payTo,
        },
      ],
    };
    const first = await payments.build(request);
    const second = await payments.build(request);

    expect(signedPaymentTxId(first.paymentSignature)).not.toBe(
      signedPaymentTxId(second.paymentSignature),
    );
  });
});

describe("wallet identity", () => {
  it("derives the payer independently from BOT_WALLET", () => {
    const account = algosdk.generateAccount();
    const botWallet = algosdk.generateAccount().addr.toString();
    const payer = walletFromMnemonic(algosdk.secretKeyToMnemonic(account.sk));
    expect(payer.address).toBe(account.addr.toString());
    expect(payer.address).not.toBe(botWallet);
  });
});
