import algosdk from "algosdk";
import { describe, expect, it, vi } from "vitest";

import type { PortfolioAction } from "../src/domain.js";
import {
  AlgorandExecutionService,
  buildQuoteRequests,
} from "../src/integrations/algorand/execution.js";
import type { Canix402Client } from "../src/integrations/canix402/client.js";
import { walletFromMnemonic } from "../src/integrations/canix402/wallet.js";
import { enterShape, opportunity } from "./fixtures.js";

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
    executionShapeKey: "mainnet:tinyman:v2:addLiquidity:flexible",
    executionInput: {
      assetAAmount: "1000",
      assetBAmount: "2000",
    },
    authorizedSpends: [{ assetId: 0, amountRaw: "1000" }],
    rationale: "Test execution validation.",
    dependencies: [],
  };
}

function dryRunService() {
  const account = algosdk.generateAccount();
  const wallet = walletFromMnemonic(algosdk.secretKeyToMnemonic(account.sk));
  const managedAddress = account.addr.toString();
  const callManagedTool = vi.fn();
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

describe("AlgorandExecutionService dry-run", () => {
  it("does not request execution quotes when signing is disabled", async () => {
    const { executor, callManagedTool } = dryRunService();

    await expect(executor.executeAction(action())).resolves.toMatchObject({
      outcome: {
        actionId: "open-1",
        status: "validated-dry-run",
      },
      payments: [],
    });
    expect(callManagedTool).not.toHaveBeenCalled();
  });

  it("skips hold actions without calling Canix402", async () => {
    const { executor, callManagedTool } = dryRunService();
    const hold = action();
    hold.type = "hold";

    await expect(executor.executeAction(hold)).resolves.toMatchObject({
      outcome: { actionId: "open-1", status: "skipped" },
    });
    expect(callManagedTool).not.toHaveBeenCalled();
  });
});

describe("buildQuoteRequests", () => {
  it("expands multi-step enter shapes in order with merged inputHints", () => {
    const candidate = opportunity({
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:folks:v2:deposit:escrow",
          order: 1,
          action: "deposit",
          variant: "escrow",
          title: "Deposit",
          summary: "Deposit",
          requiredInputs: ["assetAmount"],
          requiredAssetIds: [31_566_704],
          inputHints: { poolAppId: 123, assetId: 31_566_704 },
        }),
        enterShape({
          shapeKey: "mainnet:folks:v2:setup:escrow",
          order: 0,
          action: "setup",
          variant: "escrow",
          title: "Setup",
          summary: "Setup",
          requiredInputs: [],
          requiredAssetIds: [],
          inputHints: { poolAppId: 123 },
        }),
      ],
    });
    const quotes = buildQuoteRequests(action(), [candidate], 100);
    expect(quotes).toEqual([
      {
        shapeKey: "mainnet:folks:v2:setup:escrow",
        input: {
          poolAppId: 123,
          assetAAmount: "1000",
          assetBAmount: "2000",
          maxSlippageBps: 100,
        },
      },
      {
        shapeKey: "mainnet:folks:v2:deposit:escrow",
        input: {
          poolAppId: 123,
          assetId: 31_566_704,
          assetAAmount: "1000",
          assetBAmount: "2000",
          maxSlippageBps: 100,
        },
      },
    ]);
  });
});

describe("AlgorandExecutionService multi-quote", () => {
  it("requests quotes array and submits groups in response order", async () => {
    const account = algosdk.generateAccount();
    const wallet = walletFromMnemonic(algosdk.secretKeyToMnemonic(account.sk));
    const managedAddress = account.addr.toString();
    const callManagedTool = vi.fn().mockResolvedValue({
      data: {
        data: [
          {
            shapeKey: "mainnet:folks:v2:setup:escrow",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            encodedTransactions: ["AAAA"],
            warnings: [],
            transactions: [],
          },
          {
            shapeKey: "mainnet:folks:v2:deposit:escrow",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            encodedTransactions: ["BBBB"],
            warnings: [],
            transactions: [],
          },
        ],
        meta: { executionSubmitted: false, quoteCount: 2 },
      },
      payment: {
        amountBaseUnits: "100000",
        assetId: "31566704",
        network: "algorand:mainnet",
      },
    });

    const executor = new AlgorandExecutionService(
      { callManagedTool } as unknown as Canix402Client,
      wallet,
      managedAddress,
      "https://mainnet-api.algonode.cloud",
      {
        signingEnabled: true,
        maxSlippageBps: 100,
        maxPriceImpactPct: 3,
      },
    );
    const signAndSubmit = vi
      .spyOn(
        executor as unknown as {
          signAndSubmit: (
            actionId: string,
            members: unknown[],
          ) => Promise<{ outcome: { actionId: string; status: string } }>;
        },
        "signAndSubmit",
      )
      .mockImplementation((actionId) =>
        Promise.resolve({
          outcome: {
            actionId,
            status: "confirmed",
            transactionId: `tx-${actionId}`,
          },
        }),
      );

    const candidate = opportunity({
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:folks:v2:setup:escrow",
          order: 0,
          requiredAssetIds: [],
          inputHints: { poolAppId: 1 },
        }),
        enterShape({
          shapeKey: "mainnet:folks:v2:deposit:escrow",
          order: 1,
          requiredAssetIds: [31_566_704],
          inputHints: { poolAppId: 1, assetId: 31_566_704 },
        }),
      ],
    });

    const result = await executor.executeAction(action(), {
      opportunities: [candidate],
    });

    expect(callManagedTool).toHaveBeenCalledWith(
      "canix_get_execution_quote",
      {
        quotes: [
          expect.objectContaining({
            shapeKey: "mainnet:folks:v2:setup:escrow",
          }),
          expect.objectContaining({
            shapeKey: "mainnet:folks:v2:deposit:escrow",
          }),
        ],
      },
      managedAddress,
    );
    expect(signAndSubmit).toHaveBeenCalledTimes(2);
    expect(signAndSubmit.mock.calls[0]?.[0]).toBe("open-1:0");
    expect(signAndSubmit.mock.calls[1]?.[0]).toBe("open-1:1");
    expect(result.outcome.status).toBe("confirmed");
    expect(result.payments).toHaveLength(1);
  });
});
