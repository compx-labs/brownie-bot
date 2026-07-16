import algosdk from "algosdk";
import { describe, expect, it, vi } from "vitest";

import type { PortfolioAction } from "../src/domain.js";
import { AlgorandExecutionService } from "../src/integrations/algorand/execution.js";
import type { Canix402Client } from "../src/integrations/canix402/client.js";
import { walletFromMnemonic } from "../src/integrations/canix402/wallet.js";

function action(): PortfolioAction {
  return {
    id: "open-1",
    type: "open",
    protocol: "tinyman",
    opportunityId: "tinyman:pool:1",
    positionId: null,
    amountRaw: "1000",
    fromAssetId: 0,
    toAssetId: null,
    targetWeightPct: 10,
    executionShapeKey: "tinyman:open",
    executionInput: { amount: "1000" },
    authorizedSpends: [{ assetId: 0, amountRaw: "1000" }],
    rationale: "Test execution validation.",
    dependencies: [],
  };
}

function encodedPayment(
  sender: string,
  overrides: {
    genesisHash?: Uint8Array;
    rekeyTo?: string;
    fee?: bigint;
  } = {},
): string {
  const transaction = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender,
    receiver: algosdk.generateAccount().addr,
    amount: 1_000n,
    rekeyTo: overrides.rekeyTo,
    suggestedParams: {
      fee: overrides.fee ?? 1_000n,
      minFee: 1_000n,
      flatFee: true,
      firstValid: 100n,
      lastValid: 200n,
      genesisID: "mainnet-v1.0",
      genesisHash:
        overrides.genesisHash ??
        new Uint8Array(
          Buffer.from("wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", "base64"),
        ),
    },
  });
  return Buffer.from(algosdk.encodeUnsignedTransaction(transaction)).toString(
    "base64",
  );
}

function service(encodedTransaction: string, managedAddress: string) {
  const account = algosdk.generateAccount();
  const wallet = walletFromMnemonic(algosdk.secretKeyToMnemonic(account.sk));
  const callManagedTool = vi.fn().mockResolvedValue({
    data: {
      data: {
        shapeKey: "tinyman:open",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        encodedTransactions: [encodedTransaction],
        warnings: [],
        transactions: [],
      },
      meta: { executionSubmitted: false },
    },
  });
  const canix = { callManagedTool } as unknown as Canix402Client;
  return {
    executor: new AlgorandExecutionService(
      canix,
      wallet,
      managedAddress,
      "https://mainnet-api.algonode.cloud",
      {
        signingEnabled: false,
        maxSlippageBps: 100,
        maxPriceImpactPct: 3,
      },
    ),
    callManagedTool,
  };
}

describe("AlgorandExecutionService transaction signing", () => {
  it("accepts MCP transaction payloads without decoding in dry-run", async () => {
    const managed = algosdk.generateAccount().addr.toString();
    const { executor, callManagedTool } = service("not-a-transaction", managed);

    await expect(executor.executeAction(action())).resolves.toMatchObject({
      outcome: {
        actionId: "open-1",
        status: "validated-dry-run",
      },
    });
    expect(callManagedTool).toHaveBeenCalledWith(
      "canix_get_execution_quote",
      expect.any(Object),
      managed,
    );
  });

  it("does not locally reject transactions for a different sender", async () => {
    const managed = algosdk.generateAccount().addr.toString();
    const { executor } = service(
      encodedPayment(algosdk.generateAccount().addr.toString()),
      managed,
    );

    const result = await executor.executeAction(action());
    expect(result.outcome.status).toBe("validated-dry-run");
  });

  it("does not compare MCP transactions with approved action spends", async () => {
    const managed = algosdk.generateAccount().addr.toString();
    const { executor } = service(encodedPayment(managed), managed);
    const mismatchedAction = action();
    mismatchedAction.authorizedSpends = [{ assetId: 0, amountRaw: "2000" }];

    const result = await executor.executeAction(mismatchedAction);

    expect(result.outcome.status).toBe("validated-dry-run");
  });

  it("does not locally reject rekey or non-mainnet transactions", async () => {
    const managed = algosdk.generateAccount().addr.toString();
    const rekeyed = service(
      encodedPayment(managed, {
        rekeyTo: algosdk.generateAccount().addr.toString(),
      }),
      managed,
    );
    const rekeyedResult = await rekeyed.executor.executeAction(action());
    expect(rekeyedResult.outcome.status).toBe("validated-dry-run");

    const testnet = service(
      encodedPayment(managed, {
        genesisHash: new Uint8Array(
          Buffer.from("SGO1GKSzyE7IEPItq8mK/24B7V1s7J0rQo66kEnl0fs=", "base64"),
        ),
      }),
      managed,
    );
    const testnetResult = await testnet.executor.executeAction(action());
    expect(testnetResult.outcome.status).toBe("validated-dry-run");
  });
});
