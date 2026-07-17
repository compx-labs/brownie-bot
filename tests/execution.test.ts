import algosdk from "algosdk";
import { describe, expect, it, vi } from "vitest";

import type { PortfolioAction } from "../src/domain.js";
import {
  AlgorandExecutionService,
  buildQuoteRequests,
} from "../src/integrations/algorand/execution.js";
import { MemoryFolksEscrowStore } from "../src/integrations/algorand/folks-escrow-store.js";
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
  it("expands non-escrow multi-step enter shapes in order with scoped inputs", () => {
    const candidate = opportunity({
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:tinyman:v2:setup:pool",
          order: 0,
          action: "addLiquidity",
          variant: "setup",
          title: "Setup",
          summary: "Setup",
          requiredInputs: [],
          requiredAssetIds: [],
          inputHints: { poolAppId: 123 },
        }),
        enterShape({
          shapeKey: "mainnet:tinyman:v2:addLiquidity:flexible",
          order: 1,
          action: "addLiquidity",
          variant: "flexible",
          title: "Add",
          summary: "Add",
          requiredInputs: ["assetAAmount", "assetBAmount"],
          requiredAssetIds: [0, 31_566_704],
          inputHints: { poolAppId: 123, assetAId: 0, assetBId: 31_566_704 },
        }),
      ],
    });
    const quotes = buildQuoteRequests(action(), [candidate], 100);
    expect(quotes).toEqual([
      {
        shapeKey: "mainnet:tinyman:v2:setup:pool",
        input: {
          poolAppId: 123,
          maxSlippageBps: 100,
        },
      },
      {
        shapeKey: "mainnet:tinyman:v2:addLiquidity:flexible",
        input: {
          poolAppId: 123,
          assetAId: 0,
          assetBId: 31_566_704,
          assetAAmount: "1000",
          assetBAmount: "2000",
          maxSlippageBps: 100,
        },
      },
    ]);
  });

  it("does not batch Folks escrow shapes in buildQuoteRequests", () => {
    const candidate = opportunity({
      protocol: "folks",
      opportunityId: "folks:usdc:1",
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:folks:v2:setup:depositEscrow",
          order: 0,
          action: "setup",
          variant: "depositEscrow",
          title: "Setup",
          summary: "Setup",
          requiredInputs: [],
          requiredAssetIds: [],
          inputHints: { poolAppId: 123 },
        }),
        enterShape({
          shapeKey: "mainnet:folks:v2:deposit:escrow",
          order: 1,
          action: "deposit",
          variant: "escrow",
          title: "Deposit",
          summary: "Deposit",
          requiredInputs: ["assetAmount"],
          requiredAssetIds: [31_566_704],
          inputHints: { assetId: 31_566_704, poolAppId: 123 },
        }),
      ],
    });
    const quotes = buildQuoteRequests(
      {
        ...action(),
        protocol: "folks",
        opportunityId: "folks:usdc:1",
        executionShapeKey: "mainnet:folks:v2:deposit:escrow",
        executionInput: {
          assetId: 31_566_704,
          assetAmount: "35000000",
        },
      },
      [candidate],
      100,
    );
    expect(quotes).toEqual([
      {
        shapeKey: "mainnet:folks:v2:deposit:escrow",
        input: {
          assetId: 31_566_704,
          assetAmount: "35000000",
          maxSlippageBps: 100,
        },
      },
    ]);
  });
});

describe("AlgorandExecutionService multi-quote", () => {
  it("batches non-escrow multi-step quotes then submits in order", async () => {
    const account = algosdk.generateAccount();
    const wallet = walletFromMnemonic(algosdk.secretKeyToMnemonic(account.sk));
    const managedAddress = account.addr.toString();
    const callManagedTool = vi.fn().mockResolvedValue({
      data: {
        data: [
          {
            shapeKey: "mainnet:tinyman:v2:setup:pool",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            encodedTransactions: ["AAAA"],
            warnings: [],
            transactions: [],
          },
          {
            shapeKey: "mainnet:tinyman:v2:addLiquidity:flexible",
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
    const signAndSubmitEncoded = vi
      .spyOn(
        executor as unknown as {
          signAndSubmitEncoded: (
            actionId: string,
            encoded: string[],
            extra?: Map<string, Uint8Array>,
          ) => Promise<{ outcome: { actionId: string; status: string } }>;
        },
        "signAndSubmitEncoded",
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
          shapeKey: "mainnet:tinyman:v2:setup:pool",
          order: 0,
          action: "addLiquidity",
          variant: "setup",
          requiredInputs: [],
          requiredAssetIds: [],
          inputHints: { poolAppId: 1 },
        }),
        enterShape({
          shapeKey: "mainnet:tinyman:v2:addLiquidity:flexible",
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
            shapeKey: "mainnet:tinyman:v2:setup:pool",
          }),
          expect.objectContaining({
            shapeKey: "mainnet:tinyman:v2:addLiquidity:flexible",
          }),
        ],
      },
      managedAddress,
    );
    expect(signAndSubmitEncoded).toHaveBeenCalledTimes(2);
    expect(signAndSubmitEncoded.mock.calls[0]?.[0]).toBe("open-1:0");
    expect(signAndSubmitEncoded.mock.calls[1]?.[0]).toBe("open-1:1");
    expect(result.outcome.status).toBe("confirmed");
    expect(result.payments).toHaveLength(1);
  });

  it("quotes Folks escrow shapes one step at a time and persists setup metadata", async () => {
    const account = algosdk.generateAccount();
    const escrowAccount = algosdk.generateAccount();
    const wallet = walletFromMnemonic(algosdk.secretKeyToMnemonic(account.sk));
    const managedAddress = account.addr.toString();
    const escrowAddress = escrowAccount.addr.toString();
    const store = new MemoryFolksEscrowStore();

    const callManagedTool = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          data: [
            {
              shapeKey: "mainnet:folks-finance:v2:setup:depositEscrow",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              encodedTransactions: ["SETUP"],
              warnings: [],
              transactions: [],
              metadata: {
                escrowAddress,
                escrowPrivateKeyBase64: Buffer.from(
                  escrowAccount.sk,
                ).toString("base64"),
                depositsAppId: 971_353_536,
              },
            },
          ],
          meta: { executionSubmitted: false, quoteCount: 1 },
        },
        payment: {
          amountBaseUnits: "100000",
          assetId: "31566704",
          network: "algorand:mainnet",
        },
      })
      .mockResolvedValueOnce({
        data: {
          data: [
            {
              shapeKey: "mainnet:folks-finance:v2:setup:optEscrowAsset",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              encodedTransactions: ["OPT"],
              warnings: [],
              transactions: [],
            },
          ],
          meta: { executionSubmitted: false, quoteCount: 1 },
        },
        payment: {
          amountBaseUnits: "100000",
          assetId: "31566704",
          network: "algorand:mainnet",
        },
      })
      .mockResolvedValueOnce({
        data: {
          data: [
            {
              shapeKey: "mainnet:folks-finance:v2:deposit:escrow",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              encodedTransactions: ["DEPOSIT"],
              warnings: [],
              transactions: [],
            },
          ],
          meta: { executionSubmitted: false, quoteCount: 1 },
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
      store,
    );
    const signAndSubmitEncoded = vi
      .spyOn(
        executor as unknown as {
          signAndSubmitEncoded: (
            actionId: string,
            encoded: string[],
            extra?: Map<string, Uint8Array>,
          ) => Promise<{ outcome: { actionId: string; status: string } }>;
        },
        "signAndSubmitEncoded",
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
      protocol: "folks-finance",
      opportunityId: "folks-lending-1",
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:folks-finance:v2:setup:depositEscrow",
          order: 0,
          action: "setup",
          variant: "depositEscrow",
          requiredInputs: ["userAddress"],
          requiredAssetIds: [],
          inputHints: { poolAppId: 971_372_237, assetId: 31_566_704 },
        }),
        enterShape({
          shapeKey: "mainnet:folks-finance:v2:setup:optEscrowAsset",
          order: 1,
          action: "setup",
          variant: "optEscrowAsset",
          requiredInputs: ["userAddress", "escrowAddress"],
          requiredAssetIds: [31_566_704],
          inputHints: { poolAppId: 971_372_237, assetId: 31_566_704 },
        }),
        enterShape({
          shapeKey: "mainnet:folks-finance:v2:deposit:escrow",
          order: 2,
          action: "deposit",
          variant: "escrow",
          requiredInputs: ["userAddress", "assetAmount"],
          requiredAssetIds: [31_566_704],
          inputHints: { poolAppId: 971_372_237, assetId: 31_566_704 },
        }),
      ],
    });

    const result = await executor.executeAction(
      {
        ...action(),
        protocol: "folks-finance",
        opportunityId: "folks-lending-1",
        fromAssetId: 31_566_704,
        executionShapeKey: "mainnet:folks-finance:v2:deposit:escrow",
        executionInput: {
          assetId: 31_566_704,
          assetAmount: "1000000",
          poolAppId: 971_372_237,
        },
      },
      { opportunities: [candidate] },
    );

    expect(callManagedTool).toHaveBeenCalledTimes(3);
    expect(callManagedTool.mock.calls[0]?.[1]).toEqual({
      quotes: [
        expect.objectContaining({
          shapeKey: "mainnet:folks-finance:v2:setup:depositEscrow",
        }),
      ],
    });
    expect(callManagedTool.mock.calls[1]?.[1]).toEqual({
      quotes: [
        expect.objectContaining({
          shapeKey: "mainnet:folks-finance:v2:setup:optEscrowAsset",
          input: expect.objectContaining({ escrowAddress }),
        }),
      ],
    });
    expect(callManagedTool.mock.calls[2]?.[1]).toEqual({
      quotes: [
        expect.objectContaining({
          shapeKey: "mainnet:folks-finance:v2:deposit:escrow",
          input: expect.objectContaining({
            assetAmount: "1000000",
            escrowAddress,
          }),
        }),
      ],
    });
    expect(signAndSubmitEncoded).toHaveBeenCalledTimes(3);
    expect(result.outcome.status).toBe("confirmed");
    expect(result.payments).toHaveLength(3);

    const saved = await store.get(managedAddress, 971_372_237);
    expect(saved?.escrowAddress).toBe(escrowAddress);
  });
});
