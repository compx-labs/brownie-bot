import algosdk from "algosdk";
import { describe, expect, it, vi } from "vitest";

import type { ExecutionOutcome, PortfolioAction } from "../src/domain.js";
import {
  AlgorandExecutionService,
  applyUniqueTransactionNotes,
  buildQuoteRequests,
  buildStandaloneAssetOptInTransactions,
  clampActionAmountToSpendable,
  collectPotentialReceiveAssetIds,
  collectReceiveAssetIdsFromQuoteMetadata,
  encodedGroupHasSignedMember,
  isFolksEscrowBindingNote,
  isSkippablePrerequisiteQuoteError,
  prependAssetOptInTransactions,
  quotesNeedSequentialConfirm,
  resolveCapitalEnterSpendAssetId,
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

/** Avoid live Algod reads when open/increase clamps to spendable. */
function mockAbundantSpendable(executor: AlgorandExecutionService): void {
  vi.spyOn(
    executor as unknown as {
      readSpendableAssetRaw: (assetId: number) => Promise<bigint>;
    },
    "readSpendableAssetRaw",
  ).mockResolvedValue(10n ** 18n);
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

  it("dry-runs claim batches without compiling quotes", async () => {
    const { executor, callManagedTool } = dryRunService();
    const claim: PortfolioAction = {
      ...action(),
      id: "claim-1",
      type: "claim",
      amountRaw: null,
      authorizedSpends: [],
      executionShapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
      executionInput: { userAddress: "ADDR" },
    };
    await expect(
      executor.executeClaimBatch([claim], {
        claimable: {
          rows: [],
          claimAllQuotes: [],
          totals: { claimableUsd: null, worthClaimingUsd: null },
          meta: {},
          caveats: [],
        },
      }),
    ).resolves.toMatchObject({
      outcomes: [{ actionId: "claim-1", status: "validated-dry-run" }],
      payments: [],
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

  it("includes Pact farm:deployEscrow before addLiquidityAndFarm", () => {
    const candidate = opportunity({
      protocol: "pact",
      opportunityId: "3585364727:farm",
      assetIds: [31_566_704, 0],
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:pact:v1:farm:deployEscrow",
          protocol: "pact",
          action: "farm",
          variant: "deployEscrow",
          order: 0,
          requiredInputs: ["userAddress", "farmAppId"],
          requiredAssetIds: [],
          inputHints: { farmAppId: 3_585_364_727, poolAppId: 2_966_876_920 },
        }),
        enterShape({
          shapeKey: "mainnet:pact:v1:addLiquidityAndFarm:twoSided",
          protocol: "pact",
          action: "addLiquidityAndFarm",
          variant: "twoSided",
          order: 1,
          requiredInputs: [
            "farmAppId",
            "poolAppId",
            "assetAId",
            "assetAAmount",
            "assetBId",
            "assetBAmount",
          ],
          requiredAssetIds: [31_566_704, 0],
          inputHints: {
            farmAppId: 3_585_364_727,
            poolAppId: 2_966_876_920,
            assetAId: 31_566_704,
            assetBId: 0,
          },
        }),
        enterShape({
          shapeKey: "mainnet:pact:v1:farm:stake",
          protocol: "pact",
          action: "farm",
          variant: "stake",
          order: 1,
          requiredInputs: ["farmAppId", "amount"],
          requiredAssetIds: [],
          inputHints: { farmAppId: 3_585_364_727 },
        }),
      ],
    });
    const quotes = buildQuoteRequests(
      {
        ...action(),
        protocol: "pact",
        opportunityId: candidate.opportunityId,
        executionShapeKey: "mainnet:pact:v1:addLiquidityAndFarm:twoSided",
        fromAssetId: 31_566_704,
        amountRaw: "1000000",
        executionInput: {
          farmAppId: 3_585_364_727,
          poolAppId: 2_966_876_920,
          assetAId: 31_566_704,
          assetAAmount: "1000000",
          assetBId: 0,
          assetBAmount: "1000000",
        },
        authorizedSpends: [
          { assetId: 31_566_704, amountRaw: "1000000" },
          { assetId: 0, amountRaw: "1000000" },
        ],
      },
      [candidate],
      100,
    );
    expect(quotes.map((quote) => quote.shapeKey)).toEqual([
      "mainnet:pact:v1:farm:deployEscrow",
      "mainnet:pact:v1:addLiquidityAndFarm:twoSided",
    ]);
    expect(quotesNeedSequentialConfirm(quotes)).toBe(true);
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

  it("keeps assetId for Dork.fi deposit when poolAppId is also present", () => {
    const candidate = opportunity({
      protocol: "dorkfi",
      opportunityId: "dorkfi:algorand:3333688282:31566704:lending",
      assetIds: [31_566_704],
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:dorkfi:v1:deposit:asa",
          protocol: "dorkfi",
          action: "deposit",
          variant: "asa",
          requiredInputs: [
            "userAddress",
            "poolAppId",
            "marketAppId",
            "assetId",
            "amount",
          ],
          requiredAssetIds: [31_566_704],
          inputHints: {
            assetId: 31_566_704,
            poolAppId: 3_333_688_282,
            marketAppId: 3_333_688_282,
          },
        }),
      ],
    });
    const quotes = buildQuoteRequests(
      {
        ...action(),
        protocol: "dorkfi",
        opportunityId: candidate.opportunityId,
        executionShapeKey: "mainnet:dorkfi:v1:deposit:asa",
        fromAssetId: 31_566_704,
        amountRaw: "1000000",
        executionInput: {
          amount: "1000000",
          assetId: 31_566_704,
          poolAppId: 3_333_688_282,
          marketAppId: 3_333_688_282,
        },
        authorizedSpends: [{ assetId: 31_566_704, amountRaw: "1000000" }],
      },
      [candidate],
      100,
    );
    expect(quotes).toEqual([
      {
        shapeKey: "mainnet:dorkfi:v1:deposit:asa",
        input: {
          assetId: 31_566_704,
          poolAppId: 3_333_688_282,
          marketAppId: 3_333_688_282,
          amount: "1000000",
          maxSlippageBps: 100,
        },
      },
    ]);
  });

  it("strips assetId for Folks deposit quotes that also send poolAppId", () => {
    const candidate = opportunity({
      protocol: "folks-finance",
      opportunityId: "folks:usdc:solo",
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:folks-finance:v2:deposit:escrow",
          protocol: "folks-finance",
          action: "deposit",
          variant: "escrow",
          requiredInputs: ["assetAmount"],
          requiredAssetIds: [31_566_704],
          inputHints: { assetId: 31_566_704, poolAppId: 971_372_237 },
        }),
      ],
    });
    const quotes = buildQuoteRequests(
      {
        ...action(),
        protocol: "folks-finance",
        opportunityId: candidate.opportunityId,
        executionShapeKey: "mainnet:folks-finance:v2:deposit:escrow",
        executionInput: {
          assetId: 31_566_704,
          poolAppId: 971_372_237,
          assetAmount: "1000000",
        },
      },
      [candidate],
      100,
    );
    expect(quotes).toEqual([
      {
        shapeKey: "mainnet:folks-finance:v2:deposit:escrow",
        input: {
          poolAppId: 971_372_237,
          assetAmount: "1000000",
          maxSlippageBps: 100,
        },
      },
    ]);
  });

  it("skips deployEscrow quote errors when escrow already exists", () => {
    expect(
      isSkippablePrerequisiteQuoteError(
        "mainnet:pact:v1:farm:deployEscrow",
        new Error(
          "User already has a Pact farm escrow for this farm; skip deployEscrow",
        ),
      ),
    ).toBe(true);
    expect(
      isSkippablePrerequisiteQuoteError(
        "mainnet:pact:v1:addLiquidityAndFarm:twoSided",
        new Error("User already has a Pact farm escrow"),
      ),
    ).toBe(false);
  });

  it("quotes only flexible when Tinyman lists initial/singleAsset siblings", () => {
    const candidate = opportunity({
      protocol: "tinyman",
      opportunityId: "tinyman:pool:algo-usdc",
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:tinyman:v2:addLiquidity:flexible",
          order: 0,
          action: "addLiquidity",
          variant: "flexible",
          title: "Flexible",
          summary: "Flexible",
          requiredInputs: ["assetAAmount", "assetBAmount"],
          requiredAssetIds: [0, 31_566_704],
          inputHints: { assetAId: 0, assetBId: 31_566_704 },
        }),
        enterShape({
          shapeKey: "mainnet:tinyman:v2:addLiquidity:initial",
          order: 0,
          action: "addLiquidity",
          variant: "initial",
          title: "Initial",
          summary: "Initial",
          requiredInputs: ["assetAAmount", "assetBAmount"],
          requiredAssetIds: [0, 31_566_704],
          inputHints: { assetAId: 0, assetBId: 31_566_704 },
        }),
        enterShape({
          shapeKey: "mainnet:tinyman:v2:addLiquidity:singleAsset",
          order: 0,
          action: "addLiquidity",
          variant: "singleAsset",
          title: "Single",
          summary: "Single",
          requiredInputs: ["depositAmount"],
          requiredAssetIds: [0, 31_566_704],
          inputHints: { assetAId: 0, assetBId: 31_566_704 },
        }),
      ],
    });
    const quotes = buildQuoteRequests(
      {
        ...action(),
        protocol: "tinyman",
        opportunityId: "tinyman:pool:algo-usdc",
        executionShapeKey: "mainnet:tinyman:v2:addLiquidity:flexible",
        executionInput: {
          assetAId: 0,
          assetAAmount: "1000",
          assetBId: 31_566_704,
          assetBAmount: "2000",
        },
      },
      [candidate],
      100,
    );
    expect(quotes.map((quote) => quote.shapeKey)).toEqual([
      "mainnet:tinyman:v2:addLiquidity:flexible",
    ]);
  });

  it("does not batch exit/unstake shapes into an LST stake enter", () => {
    const candidate = opportunity({
      protocol: "folks-finance",
      opportunityId: "folks-staking-xalgo",
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:folks-finance:xalgo-v1:stake:immediate",
          order: 0,
          action: "stake",
          variant: "immediate",
          title: "Stake",
          summary: "Stake ALGO",
          requiredInputs: ["amount"],
          requiredAssetIds: [0],
          inputHints: { assetId: 0, depositAssetId: 0 },
        }),
        enterShape({
          shapeKey: "mainnet:folks-finance:xalgo-v1:unstake:immediate",
          order: 1,
          action: "unstake",
          variant: "immediate",
          title: "Unstake",
          summary: "Unstake xALGO",
          requiredInputs: ["amount"],
          requiredAssetIds: [1_134_696_561],
          inputHints: { assetId: 1_134_696_561 },
        }),
      ],
    });
    const quotes = buildQuoteRequests(
      {
        ...action(),
        protocol: "folks-finance",
        opportunityId: "folks-staking-xalgo",
        executionShapeKey: "mainnet:folks-finance:xalgo-v1:stake:immediate",
        executionInput: {
          assetId: 0,
          depositAssetId: 0,
          amount: "1000000",
        },
      },
      [candidate],
      100,
    );
    expect(quotes.map((quote) => quote.shapeKey)).toEqual([
      "mainnet:folks-finance:xalgo-v1:stake:immediate",
    ]);
  });

  it("quotes only the unstake shape when open targets LST redeem", () => {
    const candidate = opportunity({
      protocol: "folks-finance",
      opportunityId: "folks-staking-xalgo",
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:folks-finance:xalgo-v1:stake:immediate",
          order: 0,
          action: "stake",
          variant: "immediate",
          title: "Stake",
          summary: "Stake ALGO",
          requiredInputs: ["amount"],
          requiredAssetIds: [0],
          inputHints: { assetId: 0 },
        }),
        enterShape({
          shapeKey: "mainnet:folks-finance:xalgo-v1:unstake:immediate",
          order: 1,
          action: "unstake",
          variant: "immediate",
          title: "Unstake",
          summary: "Unstake xALGO",
          requiredInputs: ["amount"],
          requiredAssetIds: [1_134_696_561],
          inputHints: { assetId: 1_134_696_561 },
        }),
      ],
    });
    const quotes = buildQuoteRequests(
      {
        ...action(),
        protocol: "folks-finance",
        opportunityId: "folks-staking-xalgo",
        executionShapeKey: "mainnet:folks-finance:xalgo-v1:unstake:immediate",
        executionInput: {
          assetId: 1_134_696_561,
          amount: "500000",
        },
      },
      [candidate],
      100,
    );
    expect(quotes.map((quote) => quote.shapeKey)).toEqual([
      "mainnet:folks-finance:xalgo-v1:unstake:immediate",
    ]);
  });
});

describe("AlgorandExecutionService multi-quote", () => {
  it("compiles selected claim-desk quotes in one request", async () => {
    const account = algosdk.generateAccount();
    const wallet = walletFromMnemonic(algosdk.secretKeyToMnemonic(account.sk));
    const managedAddress = account.addr.toString();
    const callManagedTool = vi.fn().mockResolvedValue({
      data: {
        data: [
          {
            shapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            encodedTransactions: ["AAAA"],
            warnings: [],
            transactions: [],
          },
          {
            shapeKey: "mainnet:haystack:v1:claim",
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
    vi.spyOn(
      executor as unknown as {
        signAndSubmitEncoded: (
          actionId: string,
          encoded: string[],
        ) => Promise<{
          outcome: { actionId: string; status: string; transactionId?: string };
        }>;
      },
      "signAndSubmitEncoded",
    ).mockImplementation((actionId) =>
      Promise.resolve({
        outcome: {
          actionId,
          status: "confirmed",
          transactionId: `tx-${actionId}`,
        },
      }),
    );

    const claims: PortfolioAction[] = [
      {
        ...action(),
        id: "claim-farm",
        type: "claim",
        amountRaw: null,
        authorizedSpends: [],
        positionId: "tinyman:reward:1",
        executionShapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
        executionInput: {},
      },
      {
        ...action(),
        id: "claim-hay",
        type: "claim",
        protocol: "haystack",
        amountRaw: null,
        authorizedSpends: [],
        positionId: "haystack:reward:1",
        executionShapeKey: "mainnet:haystack:v1:claim",
        executionInput: {},
      },
    ];
    const result = await executor.executeClaimBatch(claims, {
      claimable: {
        rows: [
          {
            positionId: "tinyman:reward:1",
            quote: {
              shapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
              input: { poolId: "POOL" },
            },
          },
          {
            positionId: "haystack:reward:1",
            quote: {
              shapeKey: "mainnet:haystack:v1:claim",
              input: { userAddress: managedAddress },
            },
          },
        ],
        claimAllQuotes: [],
        totals: { claimableUsd: 1, worthClaimingUsd: 1 },
        meta: {},
        caveats: [],
      },
    });

    expect(callManagedTool).toHaveBeenCalledTimes(1);
    expect(callManagedTool).toHaveBeenCalledWith(
      "canix_get_execution_quote",
      {
        quotes: [
          {
            shapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
            input: { poolId: "POOL" },
          },
          {
            shapeKey: "mainnet:haystack:v1:claim",
            input: { userAddress: managedAddress },
          },
        ],
      },
      managedAddress,
    );
    expect(result.outcomes.map((outcome) => outcome.actionId)).toEqual([
      "claim-farm",
      "claim-hay",
    ]);
    expect(
      result.outcomes.every((outcome) => outcome.status === "confirmed"),
    ).toBe(true);
  });

  it("keeps a confirmed claim when a later quote throws", async () => {
    const account = algosdk.generateAccount();
    const wallet = walletFromMnemonic(algosdk.secretKeyToMnemonic(account.sk));
    const managedAddress = account.addr.toString();
    const payment = {
      amountBaseUnits: "100000",
      assetId: "31566704",
      network: "algorand:mainnet",
    };
    const callManagedTool = vi.fn().mockResolvedValue({
      data: {
        data: [
          {
            shapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            encodedTransactions: ["AAAA"],
            warnings: [],
            transactions: [],
          },
          {
            shapeKey: "mainnet:haystack:v1:claim",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            encodedTransactions: ["BBBB"],
            warnings: [],
            transactions: [],
          },
        ],
        meta: { executionSubmitted: false, quoteCount: 2 },
      },
      payment,
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
    vi.spyOn(
      executor as unknown as {
        signAndSubmitEncoded: (
          actionId: string,
          encoded: string[],
        ) => Promise<{
          outcome: { actionId: string; status: string; transactionId?: string };
        }>;
      },
      "signAndSubmitEncoded",
    )
      .mockResolvedValueOnce({
        outcome: {
          actionId: "claim-farm",
          status: "confirmed",
          transactionId: "tx-claim-farm",
        },
      })
      .mockRejectedValueOnce(
        new Error("Execution quote is expired or too close to expiry"),
      );

    const claims: PortfolioAction[] = [
      {
        ...action(),
        id: "claim-farm",
        type: "claim",
        amountRaw: null,
        authorizedSpends: [],
        positionId: "tinyman:reward:1",
        executionShapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
        executionInput: {},
      },
      {
        ...action(),
        id: "claim-hay",
        type: "claim",
        protocol: "haystack",
        amountRaw: null,
        authorizedSpends: [],
        positionId: "haystack:reward:1",
        executionShapeKey: "mainnet:haystack:v1:claim",
        executionInput: {},
      },
    ];
    const result = await executor.executeClaimBatch(claims, {
      claimable: {
        rows: [
          {
            positionId: "tinyman:reward:1",
            quote: {
              shapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
              input: { poolId: "POOL" },
            },
          },
          {
            positionId: "haystack:reward:1",
            quote: {
              shapeKey: "mainnet:haystack:v1:claim",
              input: { userAddress: managedAddress },
            },
          },
        ],
        claimAllQuotes: [],
        totals: { claimableUsd: 1, worthClaimingUsd: 1 },
        meta: {},
        caveats: [],
      },
    });

    expect(result.payments).toEqual([payment]);
    expect(result.outcomes).toEqual([
      {
        actionId: "claim-farm",
        status: "confirmed",
        transactionId: "tx-claim-farm",
        toolName: "canix_get_execution_quote",
      },
      {
        actionId: "claim-hay",
        status: "failed",
        error: "Execution quote is expired or too close to expiry",
      },
    ]);
  });

  it("submits the group that matches each action shapeKey when Canix reorders", async () => {
    const account = algosdk.generateAccount();
    const wallet = walletFromMnemonic(algosdk.secretKeyToMnemonic(account.sk));
    const managedAddress = account.addr.toString();
    const callManagedTool = vi.fn().mockResolvedValue({
      data: {
        data: [
          {
            shapeKey: "mainnet:haystack:v1:claim",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            encodedTransactions: ["HAY-GROUP"],
            warnings: [],
            transactions: [],
          },
          {
            shapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            encodedTransactions: ["TINY-GROUP"],
            warnings: [],
            transactions: [],
          },
        ],
        meta: { executionSubmitted: false, quoteCount: 2 },
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
          ) => Promise<{
            outcome: {
              actionId: string;
              status: string;
              transactionId?: string;
            };
          }>;
        },
        "signAndSubmitEncoded",
      )
      .mockImplementation((actionId, encoded) =>
        Promise.resolve({
          outcome: {
            actionId,
            status: "confirmed",
            transactionId: `tx-${encoded[0]}`,
          },
        }),
      );

    const result = await executor.executeClaimBatch(
      [
        {
          ...action(),
          id: "claim-farm",
          type: "claim",
          amountRaw: null,
          authorizedSpends: [],
          positionId: "tinyman:reward:1",
          executionShapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
          executionInput: {},
        },
        {
          ...action(),
          id: "claim-hay",
          type: "claim",
          protocol: "haystack",
          amountRaw: null,
          authorizedSpends: [],
          positionId: "haystack:reward:1",
          executionShapeKey: "mainnet:haystack:v1:claim",
          executionInput: {},
        },
      ],
      {
        claimable: {
          rows: [
            {
              positionId: "tinyman:reward:1",
              quote: {
                shapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
                input: { poolId: "POOL" },
              },
            },
            {
              positionId: "haystack:reward:1",
              quote: {
                shapeKey: "mainnet:haystack:v1:claim",
                input: {},
              },
            },
          ],
          claimAllQuotes: [],
          totals: { claimableUsd: 1, worthClaimingUsd: 1 },
          meta: {},
          caveats: [],
        },
      },
    );

    expect(signAndSubmitEncoded.mock.calls[0]?.[1]).toEqual(["TINY-GROUP"]);
    expect(signAndSubmitEncoded.mock.calls[1]?.[1]).toEqual(["HAY-GROUP"]);
    expect(result.outcomes.map((outcome) => outcome.transactionId)).toEqual([
      "tx-TINY-GROUP",
      "tx-HAY-GROUP",
    ]);
  });

  it("does not compile unmatched Réti/Folks claims in the desk batch", async () => {
    const account = algosdk.generateAccount();
    const wallet = walletFromMnemonic(algosdk.secretKeyToMnemonic(account.sk));
    const managedAddress = account.addr.toString();
    const callManagedTool = vi.fn().mockResolvedValue({
      data: {
        data: [
          {
            shapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            encodedTransactions: ["TINY"],
            warnings: [],
            transactions: [],
          },
        ],
        meta: { executionSubmitted: false, quoteCount: 1 },
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
    vi.spyOn(
      executor as unknown as {
        signAndSubmitEncoded: (
          actionId: string,
          encoded: string[],
        ) => Promise<{
          outcome: { actionId: string; status: string };
        }>;
      },
      "signAndSubmitEncoded",
    ).mockResolvedValue({
      outcome: { actionId: "claim-farm", status: "confirmed" },
    });

    const result = await executor.executeClaimBatch(
      [
        {
          ...action(),
          id: "claim-farm",
          type: "claim",
          amountRaw: null,
          authorizedSpends: [],
          positionId: "tinyman:reward:1",
          executionShapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
          executionInput: {},
        },
        {
          ...action(),
          id: "claim-reti",
          type: "claim",
          protocol: "reti",
          amountRaw: null,
          authorizedSpends: [],
          positionId: "reti:reward:1",
          opportunityId: "reti:1",
          executionShapeKey: "mainnet:reti:v1:claim",
          executionInput: {},
        },
      ],
      {
        claimable: {
          rows: [
            {
              positionId: "tinyman:reward:1",
              quote: {
                shapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
                input: { poolId: "POOL" },
              },
            },
          ],
          claimAllQuotes: [],
          totals: { claimableUsd: 1, worthClaimingUsd: 1 },
          meta: {},
          caveats: [],
        },
      },
    );

    expect(callManagedTool).toHaveBeenCalledWith(
      "canix_get_execution_quote",
      {
        quotes: [
          {
            shapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
            input: { poolId: "POOL" },
          },
        ],
      },
      managedAddress,
    );
    expect(result.outcomes.map((outcome) => outcome.actionId)).toEqual([
      "claim-farm",
    ]);
  });

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
    vi.spyOn(
      executor as unknown as {
        isAssetOptedIn: (address: string, assetId: number) => Promise<boolean>;
      },
      "isAssetOptedIn",
    ).mockResolvedValue(true);
    mockAbundantSpendable(executor);

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
                escrowPrivateKeyBase64: Buffer.from(escrowAccount.sk).toString(
                  "base64",
                ),
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
    vi.spyOn(
      executor as unknown as {
        isAssetOptedIn: (address: string, assetId: number) => Promise<boolean>;
      },
      "isAssetOptedIn",
    ).mockResolvedValue(true);
    mockAbundantSpendable(executor);

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
          input: expect.objectContaining({
            escrowAddress,
          }) as Record<string, unknown>,
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
          }) as Record<string, unknown>,
        }),
      ],
    });
    expect(signAndSubmitEncoded).toHaveBeenCalledTimes(3);
    expect(result.outcome.status).toBe("confirmed");
    expect(result.payments).toHaveLength(3);

    const saved = await store.get(managedAddress, 971_372_237);
    expect(saved?.escrowAddress).toBe(escrowAddress);
  });

  it("quotes Folks withdraw on close instead of re-running deposit escrow steps", async () => {
    const account = algosdk.generateAccount();
    const escrowAccount = algosdk.generateAccount();
    const wallet = walletFromMnemonic(algosdk.secretKeyToMnemonic(account.sk));
    const managedAddress = account.addr.toString();
    const escrowAddress = escrowAccount.addr.toString();
    const store = new MemoryFolksEscrowStore();
    await store.save({
      walletAddress: managedAddress,
      poolAppId: 971_372_237,
      escrowAddress,
      escrowPrivateKeyBase64: Buffer.from(escrowAccount.sk).toString("base64"),
    });

    const callManagedTool = vi.fn().mockResolvedValue({
      data: {
        data: [
          {
            shapeKey: "mainnet:folks-finance:v2:withdraw:escrow",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            encodedTransactions: ["WITHDRAW"],
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
    vi.spyOn(
      executor as unknown as {
        isAssetOptedIn: (address: string, assetId: number) => Promise<boolean>;
      },
      "isAssetOptedIn",
    ).mockResolvedValue(true);
    vi.spyOn(
      executor as unknown as {
        signAndSubmitEncoded: (
          actionId: string,
          encoded: string[],
          extra?: Map<string, Uint8Array>,
        ) => Promise<{ outcome: { actionId: string; status: string } }>;
      },
      "signAndSubmitEncoded",
    ).mockResolvedValue({
      outcome: {
        actionId: "close-1",
        status: "confirmed",
      },
    });

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
        id: "close-1",
        type: "close",
        protocol: "folks-finance",
        opportunityId: "folks-lending-1",
        positionId: "folks-finance:supplied:1",
        amountRaw: "15000016",
        fromAssetId: 31_566_704,
        executionShapeKey: "mainnet:folks-finance:v2:withdraw:escrow",
        executionInput: {
          assetId: 31_566_704,
          poolAppId: 971_372_237,
          amount: "15000016",
        },
        authorizedSpends: [],
      },
      { opportunities: [candidate] },
    );

    expect(callManagedTool).toHaveBeenCalledTimes(1);
    expect(callManagedTool.mock.calls[0]?.[1]).toEqual({
      quotes: [
        {
          shapeKey: "mainnet:folks-finance:v2:withdraw:escrow",
          input: expect.objectContaining({
            amount: "15000016",
            amountDenomination: "asset",
            escrowAddress,
            poolAppId: 971_372_237,
            maxSlippageBps: 100,
          }) as Record<string, unknown>,
        },
      ],
    });
    const withdrawInput = (
      callManagedTool.mock.calls[0]?.[1] as {
        quotes: Array<{ input: Record<string, unknown> }>;
      }
    ).quotes[0]?.input;
    expect(withdrawInput).not.toHaveProperty("assetId");
    expect(withdrawInput).not.toHaveProperty("assetAmount");
    expect(result.outcome.status).toBe("confirmed");
  });
});

describe("clampActionAmountToSpendable", () => {
  it("resolves spend asset from executionInput.assetId", () => {
    expect(
      resolveCapitalEnterSpendAssetId({
        ...action(),
        fromAssetId: 0,
        executionInput: { assetId: 3_160_000_000, amount: "3849222168" },
        authorizedSpends: [{ assetId: 3_160_000_000, amountRaw: "3849222168" }],
      }),
    ).toBe(3_160_000_000);
  });

  it("clamps planned stake amount down to spendable after short fill", () => {
    const planned = "3849222168";
    const spendable = 3_846_637_084n;
    const stake: PortfolioAction = {
      ...action(),
      id: "increase-haystack-hay",
      type: "increase",
      protocol: "haystack",
      amountRaw: planned,
      fromAssetId: 3_160_000_000,
      executionShapeKey: "mainnet:haystack:v1:stake:hay",
      executionInput: {
        assetId: 3_160_000_000,
        amount: planned,
        maxSlippageBps: 100,
      },
      authorizedSpends: [{ assetId: 3_160_000_000, amountRaw: planned }],
    };

    const clamped = clampActionAmountToSpendable(stake, {
      assetId: 3_160_000_000,
      spendableRaw: spendable,
    });

    expect(clamped.amountRaw).toBe(spendable.toString());
    expect(clamped.authorizedSpends).toEqual([
      { assetId: 3_160_000_000, amountRaw: spendable.toString() },
    ]);
    expect(clamped.executionInput).toMatchObject({
      assetId: 3_160_000_000,
      amount: spendable.toString(),
      maxSlippageBps: 100,
    });
  });

  it("leaves amounts unchanged when spendable covers the plan", () => {
    const stake: PortfolioAction = {
      ...action(),
      amountRaw: "1000",
      fromAssetId: 3_160_000_000,
      executionInput: { assetId: 3_160_000_000, amount: "1000" },
      authorizedSpends: [{ assetId: 3_160_000_000, amountRaw: "1000" }],
    };
    expect(
      clampActionAmountToSpendable(stake, {
        assetId: 3_160_000_000,
        spendableRaw: 1000n,
      }),
    ).toBe(stake);
  });

  it("quotes clamped amount when spendable is below the plan", async () => {
    const account = algosdk.generateAccount();
    const wallet = walletFromMnemonic(algosdk.secretKeyToMnemonic(account.sk));
    const managedAddress = account.addr.toString();
    const hayAssetId = 3_160_000_000;
    const planned = "3849222168";
    const spendable = 3_846_637_084n;

    const callManagedTool = vi.fn().mockResolvedValue({
      data: {
        data: [
          {
            shapeKey: "mainnet:haystack:v1:stake:hay",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            encodedTransactions: ["STAKE"],
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
    );
    vi.spyOn(
      executor as unknown as {
        readSpendableAssetRaw: (assetId: number) => Promise<bigint>;
      },
      "readSpendableAssetRaw",
    ).mockResolvedValue(spendable);
    vi.spyOn(
      executor as unknown as {
        isAssetOptedIn: (address: string, assetId: number) => Promise<boolean>;
      },
      "isAssetOptedIn",
    ).mockResolvedValue(true);
    vi.spyOn(
      executor as unknown as {
        signAndSubmitEncoded: (
          actionId: string,
          encoded: string[],
        ) => Promise<{ outcome: { actionId: string; status: string } }>;
      },
      "signAndSubmitEncoded",
    ).mockResolvedValue({
      outcome: { actionId: "increase-haystack-hay", status: "confirmed" },
    });

    const candidate = opportunity({
      protocol: "haystack",
      opportunityId: "haystack-staking-hay",
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:haystack:v1:stake:hay",
          protocol: "haystack",
          action: "stake",
          variant: "hay",
          requiredInputs: ["assetId", "amount"],
          requiredAssetIds: [hayAssetId],
          inputHints: { assetId: hayAssetId },
        }),
      ],
    });

    await executor.executeAction(
      {
        ...action(),
        id: "increase-haystack-hay",
        type: "increase",
        protocol: "haystack",
        opportunityId: "haystack-staking-hay",
        amountRaw: planned,
        fromAssetId: hayAssetId,
        executionShapeKey: "mainnet:haystack:v1:stake:hay",
        executionInput: {
          assetId: hayAssetId,
          amount: planned,
        },
        authorizedSpends: [{ assetId: hayAssetId, amountRaw: planned }],
        dependencies: ["swap-usdc-to-hay"],
      },
      { opportunities: [candidate] },
    );

    expect(callManagedTool).toHaveBeenCalledWith(
      "canix_get_execution_quote",
      {
        quotes: [
          {
            shapeKey: "mainnet:haystack:v1:stake:hay",
            input: {
              assetId: hayAssetId,
              amount: spendable.toString(),
              maxSlippageBps: 100,
            },
          },
        ],
      },
      managedAddress,
    );
  });
});

describe("Haystack swap price impact", () => {
  const usdcAssetId = 31_566_704;
  const compxAssetId = 1_732_165_149;

  function swapAction(): PortfolioAction {
    return {
      id: "swap-compx",
      type: "swap",
      protocol: "haystack",
      opportunityId: null,
      positionId: null,
      amountRaw: "65000000",
      fromAssetId: usdcAssetId,
      toAssetId: compxAssetId,
      targetWeightPct: null,
      executionShapeKey: null,
      executionInput: null,
      authorizedSpends: [{ assetId: usdcAssetId, amountRaw: "65000000" }],
      rationale: "Accumulate COMPX toward preferred-hold target.",
      dependencies: [],
    };
  }

  function quotePayload(userPriceImpact: number) {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    return {
      data: {
        data: {
          address: "TEST",
          fromAssetId: String(usdcAssetId),
          toAssetId: String(compxAssetId),
          amount: "65000000",
          type: "fixed-input" as const,
          quotedAmount: "1000000",
          createdAt: new Date().toISOString(),
          expiresAt,
          requiredAppOptIns: [],
          txnPayload: {},
          userPriceImpact,
          marketPriceImpact: userPriceImpact,
          route: [],
          quotes: [],
          protocolFees: {},
        },
        meta: { executionSubmitted: false as const },
      },
    };
  }

  function swapMocks(
    callManagedTool: ReturnType<typeof vi.fn>,
    impact: number,
  ) {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    callManagedTool
      .mockResolvedValueOnce(quotePayload(impact))
      .mockResolvedValueOnce({
        data: {
          data: {
            required: false,
            transactions: [],
            userSignIndexes: [],
            expiresAt,
          },
          meta: { executionSubmitted: false },
        },
      })
      .mockResolvedValueOnce({
        data: {
          data: {
            transactions: [
              {
                index: 0,
                encodedTransaction: "SWAPTX",
                signedTransaction: "SIGNED",
                signer: "haystack",
              },
            ],
            userSignIndexes: [],
            createdAt: new Date().toISOString(),
            quoteExpiresAt: expiresAt,
          },
          meta: { executionSubmitted: false },
        },
      });
  }

  it("fails when price impact exceeds the cap", async () => {
    const account = algosdk.generateAccount();
    const wallet = walletFromMnemonic(algosdk.secretKeyToMnemonic(account.sk));
    const managedAddress = account.addr.toString();
    const callManagedTool = vi.fn();
    swapMocks(callManagedTool, 8.5);

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

    await expect(executor.executeAction(swapAction())).resolves.toMatchObject({
      outcome: {
        actionId: "swap-compx",
        status: "failed",
        error: "Haystack price impact exceeds 3%",
      },
    });
    expect(callManagedTool).toHaveBeenCalledTimes(1);
  });

  it("waives price-impact cap when buying a preferred-hold ASA", async () => {
    const account = algosdk.generateAccount();
    const wallet = walletFromMnemonic(algosdk.secretKeyToMnemonic(account.sk));
    const managedAddress = account.addr.toString();
    const callManagedTool = vi.fn();
    swapMocks(callManagedTool, 8.5);

    const executor = new AlgorandExecutionService(
      { callManagedTool } as unknown as Canix402Client,
      wallet,
      managedAddress,
      "https://mainnet-api.algonode.cloud",
      {
        signingEnabled: true,
        maxSlippageBps: 100,
        maxPriceImpactPct: 3,
        priceImpactExemptToAssetIds: [compxAssetId],
      },
    );
    vi.spyOn(
      executor as unknown as {
        signAndSubmit: (
          actionId: string,
          members: unknown[],
        ) => Promise<{ outcome: ExecutionOutcome }>;
      },
      "signAndSubmit",
    ).mockResolvedValue({
      outcome: {
        actionId: "swap-compx",
        status: "confirmed",
        transactionId: "TX-COMPX",
      },
    });

    await expect(executor.executeAction(swapAction())).resolves.toMatchObject({
      outcome: {
        actionId: "swap-compx",
        status: "confirmed",
        toolName: "canix_swap",
      },
    });
    expect(callManagedTool).toHaveBeenCalledWith(
      "canix_swap",
      expect.objectContaining({ slippage: 1 }),
      managedAddress,
    );
  });
});

describe("ASA opt-in helpers", () => {
  it("collects non-ALGO opportunity assets as potential receive targets", () => {
    const stake = opportunity({
      protocol: "folks-finance",
      opportunityId: "folks-staking-xalgo",
      assetPair: "ALGO/xALGO",
      assetIds: [0, 1_134_696_561],
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:folks-finance:xalgo-v1:stake:immediate",
          protocol: "folks-finance",
          action: "stake",
          variant: "immediate",
          requiredInputs: ["amount"],
          requiredAssetIds: [0],
          inputHints: { assetId: 0, depositAssetId: 0 },
        }),
      ],
    });
    const open: PortfolioAction = {
      ...action(),
      protocol: "folks-finance",
      opportunityId: stake.opportunityId,
      executionShapeKey: "mainnet:folks-finance:xalgo-v1:stake:immediate",
      fromAssetId: 0,
      toAssetId: null,
      authorizedSpends: [{ assetId: 0, amountRaw: "1000000" }],
    };
    expect(collectPotentialReceiveAssetIds(open, stake)).toEqual([
      1_134_696_561,
    ]);
  });

  it("collects Tinyman/Pact LP token ids from quote metadata", () => {
    expect(
      collectReceiveAssetIdsFromQuoteMetadata({
        poolTokenId: 1_002_590_888,
        asset1Id: 31_566_704,
        asset2Id: 0,
      }),
    ).toEqual([1_002_590_888]);
    expect(
      collectReceiveAssetIdsFromQuoteMetadata({
        liquidityAssetId: "123456",
      }),
    ).toEqual([123_456]);
    expect(collectReceiveAssetIdsFromQuoteMetadata(undefined)).toEqual([]);
  });

  it("prepends ASA opt-ins as the leading transactions in a rebuilt group", () => {
    const account = algosdk.generateAccount();
    const sender = account.addr.toString();
    const suggestedParams = {
      fee: 1_000n,
      flatFee: true as const,
      firstValid: 10n,
      lastValid: 1_010n,
      genesisHash: new Uint8Array(32),
      genesisID: "testnet-v1.0",
      minFee: 1_000n,
    };
    const payment = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender,
      receiver: sender,
      amount: 1_000_000n,
      suggestedParams,
    });
    const appCall = algosdk.makeApplicationNoOpTxnFromObject({
      sender,
      appIndex: 1_134_695_678,
      suggestedParams,
      appArgs: [],
    });
    const [groupedPayment, groupedApp] = algosdk.assignGroupID([
      payment,
      appCall,
    ]);
    const encoded = [groupedPayment!, groupedApp!].map((transaction) =>
      Buffer.from(algosdk.encodeUnsignedTransaction(transaction)).toString(
        "base64",
      ),
    );

    const withOptIn = prependAssetOptInTransactions(
      encoded,
      sender,
      [1_134_696_561],
    );
    expect(withOptIn).toHaveLength(3);

    const decoded = withOptIn.map((value) =>
      algosdk.decodeUnsignedTransaction(Buffer.from(value, "base64")),
    );
    expect(decoded[0]?.type).toBe(algosdk.TransactionType.axfer);
    expect(Number(decoded[0]?.assetTransfer?.assetIndex)).toBe(1_134_696_561);
    expect(decoded[0]?.assetTransfer?.amount).toBe(0n);
    expect(decoded[0]?.sender.toString()).toBe(sender);
    expect(decoded[0]?.assetTransfer?.receiver.toString()).toBe(sender);
    expect(decoded[1]?.type).toBe(algosdk.TransactionType.pay);
    expect(decoded[2]?.type).toBe(algosdk.TransactionType.appl);

    const groupId = decoded[0]?.group;
    expect(groupId).toBeDefined();
    expect(decoded[1]?.group).toEqual(groupId);
    expect(decoded[2]?.group).toEqual(groupId);
  });
});

describe("provider-signed claim groups", () => {
  const suggestedParams = {
    fee: 1_000n,
    flatFee: true as const,
    firstValid: 10n,
    lastValid: 1_010n,
    genesisHash: new Uint8Array(32),
    genesisID: "testnet-v1.0",
    minFee: 1_000n,
  };

  function encodeUnsignedPayment(sender: string): string {
    const transaction = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender,
      receiver: sender,
      amount: 0n,
      suggestedParams,
    });
    return Buffer.from(algosdk.encodeUnsignedTransaction(transaction)).toString(
      "base64",
    );
  }

  function encodeSignedPayment(
    account: ReturnType<typeof algosdk.generateAccount>,
  ): string {
    const transaction = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: account.addr.toString(),
      receiver: account.addr.toString(),
      amount: 0n,
      suggestedParams,
    });
    return Buffer.from(transaction.signTxn(account.sk)).toString("base64");
  }

  it("detects mixed unsigned + provider-signed members", () => {
    const user = algosdk.generateAccount();
    const provider = algosdk.generateAccount();
    const encoded = [
      encodeUnsignedPayment(user.addr.toString()),
      encodeSignedPayment(provider),
    ];
    expect(encodedGroupHasSignedMember(encoded)).toBe(true);
    expect(encodedGroupHasSignedMember([encoded[0]!])).toBe(false);
    expect(() =>
      prependAssetOptInTransactions(
        encoded,
        user.addr.toString(),
        [1_134_696_561],
      ),
    ).toThrow(/provider-signed/);
  });

  it("submits signed members as-is without uniqueness regroup", async () => {
    const account = algosdk.generateAccount();
    const provider = algosdk.generateAccount();
    const wallet = walletFromMnemonic(algosdk.secretKeyToMnemonic(account.sk));
    const managedAddress = account.addr.toString();
    const unsigned = encodeUnsignedPayment(managedAddress);
    const signed = encodeSignedPayment(provider);
    const signedBytes = new Uint8Array(Buffer.from(signed, "base64"));

    const executor = new AlgorandExecutionService(
      { callManagedTool: vi.fn() } as unknown as Canix402Client,
      wallet,
      managedAddress,
      "https://mainnet-api.algonode.cloud",
      {
        signingEnabled: true,
        maxSlippageBps: 100,
        maxPriceImpactPct: 3,
      },
    );
    const captured: Uint8Array[][] = [];
    const algod = (executor as unknown as { algod: algosdk.Algodv2 }).algod;
    vi.spyOn(algod, "sendRawTransaction").mockImplementation((txns) => {
      captured.push([...(txns as Uint8Array[])]);
      return {
        do: () => Promise.resolve({ txid: "TX-SIGNED" }),
      } as ReturnType<algosdk.Algodv2["sendRawTransaction"]>;
    });
    const waitSpy = vi
      .spyOn(
        executor as unknown as {
          waitForSubmittedTransaction: (
            txid: string,
          ) => Promise<{ confirmedRound?: bigint | number }>;
        },
        "waitForSubmittedTransaction",
      )
      .mockResolvedValue({ confirmedRound: 11n });

    await (
      executor as unknown as {
        signAndSubmitEncoded: (
          actionId: string,
          encoded: string[],
        ) => Promise<{ outcome: ExecutionOutcome }>;
      }
    ).signAndSubmitEncoded("claim-analytics", [unsigned, signed]);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.[1]).toEqual(signedBytes);
    expect(() => algosdk.decodeUnsignedTransaction(captured[0]![1]!)).toThrow();
    waitSpy.mockRestore();
  });

  it("opts in as a separate group before an unmodified signed claim group", async () => {
    const account = algosdk.generateAccount();
    const provider = algosdk.generateAccount();
    const wallet = walletFromMnemonic(algosdk.secretKeyToMnemonic(account.sk));
    const managedAddress = account.addr.toString();
    const unsigned = encodeUnsignedPayment(managedAddress);
    const signed = encodeSignedPayment(provider);
    const rewardAssetId = 1_002_590_888;
    const callManagedTool = vi.fn().mockResolvedValue({
      data: {
        data: [
          {
            shapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            encodedTransactions: [unsigned, signed],
            warnings: [],
            transactions: [],
            metadata: { poolTokenId: rewardAssetId },
          },
        ],
        meta: { executionSubmitted: false, quoteCount: 1 },
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
    vi.spyOn(
      executor as unknown as {
        isAssetOptedIn: (address: string, assetId: number) => Promise<boolean>;
      },
      "isAssetOptedIn",
    ).mockResolvedValue(false);
    const signAndSubmitEncoded = vi
      .spyOn(
        executor as unknown as {
          signAndSubmitEncoded: (
            actionId: string,
            encoded: string[],
          ) => Promise<{
            outcome: {
              actionId: string;
              status: string;
              transactionId?: string;
            };
          }>;
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

    const result = await executor.executeClaimBatch(
      [
        {
          ...action(),
          id: "claim-farm",
          type: "claim",
          amountRaw: null,
          authorizedSpends: [],
          positionId: "tinyman:reward:1",
          executionShapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
          executionInput: {},
        },
      ],
      {
        claimable: {
          rows: [
            {
              positionId: "tinyman:reward:1",
              quote: {
                shapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
                input: { poolId: "POOL" },
              },
            },
          ],
          claimAllQuotes: [],
          totals: { claimableUsd: 1, worthClaimingUsd: 1 },
          meta: {},
          caveats: [],
        },
      },
    );

    expect(signAndSubmitEncoded).toHaveBeenCalledTimes(2);
    expect(signAndSubmitEncoded.mock.calls[0]?.[0]).toBe("claim-farm:optin");
    const optInBlob = signAndSubmitEncoded.mock.calls[0]?.[1]?.[0];
    expect(optInBlob).toEqual(expect.any(String));
    const optInDecoded = algosdk.decodeUnsignedTransaction(
      Buffer.from(optInBlob ?? "", "base64"),
    );
    expect(optInDecoded.type).toBe(algosdk.TransactionType.axfer);
    expect(Number(optInDecoded.assetTransfer?.assetIndex)).toBe(rewardAssetId);
    expect(signAndSubmitEncoded.mock.calls[1]?.[0]).toBe("claim-farm");
    expect(signAndSubmitEncoded.mock.calls[1]?.[1]).toEqual([unsigned, signed]);
    expect(result.outcomes[0]?.status).toBe("confirmed");

    const standalone = buildStandaloneAssetOptInTransactions(
      [unsigned, signed],
      managedAddress,
      [rewardAssetId],
    );
    expect(standalone).toHaveLength(1);
    expect(encodedGroupHasSignedMember(standalone)).toBe(false);
  });
});

describe("applyUniqueTransactionNotes", () => {
  const suggestedParams = {
    fee: 1_000n,
    flatFee: true as const,
    firstValid: 10n,
    lastValid: 1_010n,
    genesisHash: new Uint8Array(32),
    genesisID: "testnet-v1.0",
    minFee: 1_000n,
  };

  function encodeGroup(sender: string, note?: Uint8Array): string[] {
    const payment = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender,
      receiver: sender,
      amount: 1_000_000n,
      note,
      suggestedParams,
    });
    const appCall = algosdk.makeApplicationNoOpTxnFromObject({
      sender,
      appIndex: 1_134_695_678,
      suggestedParams,
      appArgs: [],
      note,
    });
    return algosdk
      .assignGroupID([payment, appCall])
      .map((transaction) =>
        Buffer.from(algosdk.encodeUnsignedTransaction(transaction)).toString(
          "base64",
        ),
      );
  }

  function decodeNote(encoded: string): string {
    const transaction = algosdk.decodeUnsignedTransaction(
      Buffer.from(encoded, "base64"),
    );
    return new TextDecoder().decode(transaction.note ?? new Uint8Array());
  }

  it("produces distinct txids for identical quote payloads", () => {
    const sender = algosdk.generateAccount().addr.toString();
    const encoded = encodeGroup(sender);

    const first = applyUniqueTransactionNotes(encoded, "compx-lending-enter");
    const second = applyUniqueTransactionNotes(encoded, "compx-lending-enter");

    const firstIds = first.map((value) =>
      algosdk.decodeUnsignedTransaction(Buffer.from(value, "base64")).txID(),
    );
    const secondIds = second.map((value) =>
      algosdk.decodeUnsignedTransaction(Buffer.from(value, "base64")).txID(),
    );
    expect(firstIds).not.toEqual(secondIds);
    expect(new Set(firstIds).size).toBe(firstIds.length);
    expect(new Set(secondIds).size).toBe(secondIds.length);
  });

  it("preserves protocol note prefixes and rebuilds the group id", () => {
    const sender = algosdk.generateAccount().addr.toString();
    const prefix = new TextEncoder().encode("lending deposit");
    const encoded = encodeGroup(sender, prefix);

    const unique = applyUniqueTransactionNotes(
      encoded,
      "dorkfi-usdc-lending-enter",
      "nonce-fixed",
    );
    const decoded = unique.map((value) =>
      algosdk.decodeUnsignedTransaction(Buffer.from(value, "base64")),
    );

    expect(decodeNote(unique[0]!)).toBe(
      "lending deposit|brownie|dorkfi-usdc-lending-enter|nonce-fixed|0",
    );
    expect(decodeNote(unique[1]!)).toBe(
      "lending deposit|brownie|dorkfi-usdc-lending-enter|nonce-fixed|1",
    );
    expect(decoded[0]?.group).toBeDefined();
    expect(decoded[1]?.group).toEqual(decoded[0]?.group);
  });

  it("leaves Folks escrow-binding notes unchanged", () => {
    const escrow = algosdk.generateAccount();
    const note = Uint8Array.from([
      ...new TextEncoder().encode("la "),
      ...algosdk.decodeAddress(escrow.addr.toString()).publicKey,
    ]);
    expect(isFolksEscrowBindingNote(note)).toBe(true);
    const sender = algosdk.generateAccount().addr.toString();
    const encoded = encodeGroup(sender, note);
    const unique = applyUniqueTransactionNotes(
      encoded,
      "folks-credit-loan",
      "n",
    );
    const decoded = algosdk.decodeUnsignedTransaction(
      Buffer.from(unique[0]!, "base64"),
    );
    expect(Buffer.from(decoded.note ?? [])).toEqual(Buffer.from(note));
  });
});
