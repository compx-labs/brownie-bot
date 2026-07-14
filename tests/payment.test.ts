import algosdk from "algosdk";
import { describe, expect, it } from "vitest";

import { AlgorandPaymentBuilder } from "../src/integrations/canix402/payment.js";
import { walletFromMnemonic } from "../src/integrations/canix402/wallet.js";

const network = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";

function builder() {
  const walletAccount = algosdk.generateAccount();
  const wallet = walletFromMnemonic(
    algosdk.secretKeyToMnemonic(walletAccount.sk),
  );
  return new AlgorandPaymentBuilder(wallet, {
    algodUrl: "https://mainnet-api.algonode.cloud",
  });
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
