import { describe, expect, it } from "vitest";

import type { PortfolioAction, PortfolioSnapshot } from "../src/domain.js";
import {
  TINYMAN_FARM_CLAIM_SHAPE,
  USDC_ASSET_ID,
  completeActionExecutionInput,
  inferClaimRequiredInputs,
  inferEnterRequiredInputs,
  parseTinymanFarmNotes,
  parseTinymanRewardPositionId,
  parseTinymanRewardPositionHints,
  resolveShapeForAction,
} from "../src/services/shape-execution-input.js";
import {
  enterShape,
  opportunity,
  portfolioSnapshot,
  position,
} from "./fixtures.js";

const POOL = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";
const TINY_ASSET = 31_566_704;
const REWARD_POSITION_ID = `tinyman:reward:${POOL}:123456:${TINY_ASSET}`;

function rewardPosition(overrides: Parameters<typeof position>[0] = {}) {
  return position({
    protocol: "tinyman",
    positionType: "reward",
    positionId: REWARD_POSITION_ID,
    opportunityId: "tinyman:pool:1:farm",
    assetId: TINY_ASSET,
    assetSymbol: "TINY",
    amountRaw: "1000",
    amount: "0.001",
    usdValue: 0.05,
    compatibleExitShapeKeys: [],
    compatibleManageShapeKeys: [TINYMAN_FARM_CLAIM_SHAPE],
    notes: `Farm programId=999; poolAddress=${POOL}`,
    ...overrides,
  });
}

function claimAction(
  overrides: Partial<PortfolioAction> = {},
): PortfolioAction {
  return {
    id: "a3",
    type: "claim",
    protocol: "tinyman",
    opportunityId: "tinyman:pool:1:farm",
    positionId: REWARD_POSITION_ID,
    amountRaw: null,
    fromAssetId: null,
    toAssetId: null,
    targetWeightPct: null,
    executionShapeKey: TINYMAN_FARM_CLAIM_SHAPE,
    executionInput: null,
    authorizedSpends: [],
    rationale: "Claim accrued Tinyman farm rewards.",
    dependencies: [],
    ...overrides,
  };
}

describe("Tinyman farm claim synthesis", () => {
  it("parses programId and poolAddress from reward positionId", () => {
    expect(parseTinymanRewardPositionId(REWARD_POSITION_ID)).toEqual({
      poolAddress: POOL,
      poolId: POOL,
      programId: 123_456,
    });
  });

  it("parses farm notes and prefers positionId over notes", () => {
    expect(
      parseTinymanFarmNotes(`Farm programId=999; poolAddress=${POOL}`),
    ).toEqual({
      programId: 999,
      poolAddress: POOL,
      poolId: POOL,
    });

    expect(
      parseTinymanRewardPositionHints(
        rewardPosition({
          notes: `Farm programId=999; poolAddress=${POOL}`,
        }),
      ),
    ).toMatchObject({
      programId: 123_456,
      poolAddress: POOL,
    });
  });

  it("infers claimRewards required inputs", () => {
    expect(inferClaimRequiredInputs(TINYMAN_FARM_CLAIM_SHAPE)).toEqual([
      "userAddress",
      "programId",
      "poolAddress",
    ]);
  });

  it("synthesizes claim shape and completes executionInput from positionId", () => {
    const snapshot: PortfolioSnapshot = portfolioSnapshot({
      positions: [rewardPosition({ notes: undefined })],
    });
    const action = claimAction({ executionInput: null });

    const shape = resolveShapeForAction(action, [], snapshot);
    expect(shape?.shapeKey).toBe(TINYMAN_FARM_CLAIM_SHAPE);
    expect(shape?.requiredInputs).toEqual([
      "userAddress",
      "programId",
      "poolAddress",
    ]);
    expect(shape?.inputHints).toMatchObject({
      programId: 123_456,
      poolAddress: POOL,
      poolId: POOL,
    });

    const completed = completeActionExecutionInput(action, [], snapshot);
    expect(completed.executionInput).toMatchObject({
      programId: 123_456,
      poolAddress: POOL,
      poolId: POOL,
    });
    // Claim-all: do not copy position.amountRaw onto the action.
    expect(completed.amountRaw).toBeNull();
  });

  it("clears LLM zero amountRaw on claim-all so policy does not hard-block", () => {
    const snapshot: PortfolioSnapshot = portfolioSnapshot({
      positions: [rewardPosition({ amountRaw: "0", amount: "0", usdValue: 0 })],
    });
    const completed = completeActionExecutionInput(
      claimAction({ amountRaw: "0", executionInput: null }),
      [],
      snapshot,
    );
    expect(completed.amountRaw).toBeNull();
    expect(completed.executionInput).toMatchObject({
      programId: 123_456,
      poolAddress: POOL,
    });
  });

  it("clears zero amountRaw on claim-all even when executionInput is already complete", () => {
    const snapshot: PortfolioSnapshot = portfolioSnapshot({
      positions: [rewardPosition()],
    });
    const completed = completeActionExecutionInput(
      claimAction({
        amountRaw: "0",
        executionInput: {
          userAddress: "ADDR",
          programId: 123_456,
          poolAddress: POOL,
          poolId: POOL,
        },
      }),
      [],
      snapshot,
    );
    expect(completed.amountRaw).toBeNull();
  });

  it("does not synthesize claim when executionShapeKey is missing", () => {
    const snapshot = portfolioSnapshot({
      positions: [rewardPosition()],
    });
    const completed = completeActionExecutionInput(
      claimAction({
        amountRaw: "0",
        executionShapeKey: null,
        executionInput: null,
      }),
      [],
      snapshot,
    );
    expect(completed.executionInput).toBeNull();
    // Unknown shape: still clear explicit zero so the sibling actions can pass policy.
    expect(completed.amountRaw).toBeNull();
  });
});

describe("Tinyman single-asset deposit completion", () => {
  it("fills depositAssetId and depositAmount for addLiquidityAndFarm:singleAsset", () => {
    const candidate = opportunity({
      protocol: "tinyman",
      opportunityId: "tinyman:tiny-usdc:farm",
      assetIds: [USDC_ASSET_ID, 0],
      assetPair: "TINY/USDC",
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:tinyman:v2:addLiquidityAndFarm:singleAsset",
          protocol: "tinyman",
          action: "addLiquidityAndFarm",
          variant: "singleAsset",
          requiredInputs: [
            "userAddress",
            "assetAId",
            "assetBId",
            "depositAssetId",
            "depositAmount",
            "maxSlippageBps",
          ],
          requiredAssetIds: [USDC_ASSET_ID, 0],
          inputHints: {
            assetAId: USDC_ASSET_ID,
            assetBId: 0,
            poolId: POOL,
          },
        }),
      ],
    });

    const completed = completeActionExecutionInput(
      {
        id: "open-tinyman-tiny-usdc-farm",
        type: "open",
        protocol: "tinyman",
        opportunityId: candidate.opportunityId,
        positionId: null,
        amountRaw: "30000000",
        fromAssetId: USDC_ASSET_ID,
        toAssetId: null,
        targetWeightPct: 10,
        executionShapeKey: "mainnet:tinyman:v2:addLiquidityAndFarm:singleAsset",
        executionInput: {
          depositAssetId: null,
          assetAId: USDC_ASSET_ID,
          assetBId: 0,
        },
        authorizedSpends: [{ assetId: USDC_ASSET_ID, amountRaw: "30000000" }],
        rationale: "Single-sided USDC into TINY/USDC farm.",
        dependencies: [],
      },
      [candidate],
    );

    expect(completed.executionInput).toMatchObject({
      depositAssetId: USDC_ASSET_ID,
      depositAmount: "30000000",
      assetAId: USDC_ASSET_ID,
      assetBId: 0,
    });
  });

  it("coerces string depositAssetId to an integer", () => {
    const candidate = opportunity({
      opportunityId: "tinyman:pool:single",
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:tinyman:v2:addLiquidity:singleAsset",
          variant: "singleAsset",
          requiredInputs: [
            "depositAssetId",
            "depositAmount",
            "assetAId",
            "assetBId",
          ],
          requiredAssetIds: [USDC_ASSET_ID, 0],
          inputHints: { assetAId: USDC_ASSET_ID, assetBId: 0 },
        }),
      ],
    });

    const completed = completeActionExecutionInput(
      {
        id: "open-1",
        type: "open",
        protocol: "tinyman",
        opportunityId: candidate.opportunityId,
        positionId: null,
        amountRaw: "1000000",
        fromAssetId: USDC_ASSET_ID,
        toAssetId: null,
        targetWeightPct: null,
        executionShapeKey: "mainnet:tinyman:v2:addLiquidity:singleAsset",
        executionInput: { depositAssetId: String(USDC_ASSET_ID) },
        authorizedSpends: [{ assetId: USDC_ASSET_ID, amountRaw: "1000000" }],
        rationale: "test",
        dependencies: [],
      },
      [candidate],
    );

    expect(completed.executionInput?.depositAssetId).toBe(USDC_ASSET_ID);
    expect(completed.executionInput?.depositAmount).toBe("1000000");
  });

  it("fills outputAssetId for removeLiquidity:singleAssetOut", () => {
    const candidate = opportunity({
      opportunityId: "tinyman:tiny-usdc",
      assetIds: [USDC_ASSET_ID, 0],
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:tinyman:v2:removeLiquidity:singleAssetOut",
          action: "removeLiquidity",
          variant: "singleAssetOut",
          requiredInputs: [
            "assetAId",
            "assetBId",
            "poolTokenAmount",
            "outputAssetId",
            "maxSlippageBps",
          ],
          requiredAssetIds: [USDC_ASSET_ID, 0],
          inputHints: {
            assetAId: USDC_ASSET_ID,
            assetBId: 0,
            poolId: POOL,
          },
        }),
      ],
    });
    const lpPosition = position({
      protocol: "tinyman",
      positionId: "tinyman:lp:1",
      opportunityId: candidate.opportunityId,
      amountRaw: "566500000",
      compatibleExitShapeKeys: [
        "mainnet:tinyman:v2:removeLiquidity:singleAssetOut",
      ],
    });

    const completed = completeActionExecutionInput(
      {
        id: "a1",
        type: "reduce",
        protocol: "tinyman",
        opportunityId: candidate.opportunityId,
        positionId: lpPosition.positionId,
        amountRaw: "566500000",
        fromAssetId: null,
        toAssetId: null,
        targetWeightPct: 35,
        executionShapeKey: "mainnet:tinyman:v2:removeLiquidity:singleAssetOut",
        executionInput: {
          assetAId: USDC_ASSET_ID,
          assetBId: 0,
          poolTokenAmount: "566500000",
          outputAssetId: null,
        },
        authorizedSpends: [],
        rationale: "Reduce TINY/USDC LP toward maxPositionPct.",
        dependencies: [],
      },
      [candidate],
      portfolioSnapshot({ positions: [lpPosition] }),
    );

    expect(completed.executionInput).toMatchObject({
      outputAssetId: USDC_ASSET_ID,
      poolTokenAmount: "566500000",
      assetAId: USDC_ASSET_ID,
      assetBId: 0,
    });
  });

  it("prefers action.toAssetId when filling outputAssetId", () => {
    const candidate = opportunity({
      opportunityId: "tinyman:pool:algo-usdc",
      assetIds: [USDC_ASSET_ID, 0],
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:tinyman:v2:removeLiquidity:singleAssetOut",
          action: "removeLiquidity",
          variant: "singleAssetOut",
          requiredInputs: ["outputAssetId", "poolTokenAmount"],
          requiredAssetIds: [USDC_ASSET_ID, 0],
          inputHints: { assetAId: USDC_ASSET_ID, assetBId: 0 },
        }),
      ],
    });

    const completed = completeActionExecutionInput(
      {
        id: "reduce-1",
        type: "reduce",
        protocol: "tinyman",
        opportunityId: candidate.opportunityId,
        positionId: "tinyman:lp:1",
        amountRaw: "1000",
        fromAssetId: null,
        toAssetId: 0,
        targetWeightPct: null,
        executionShapeKey: "mainnet:tinyman:v2:removeLiquidity:singleAssetOut",
        executionInput: null,
        authorizedSpends: [],
        rationale: "Exit to ALGO.",
        dependencies: [],
      },
      [candidate],
    );

    expect(completed.executionInput?.outputAssetId).toBe(0);
  });
});

describe("Réti increase synthesis from held position", () => {
  const RETI_STAKE = "mainnet:reti:v1:stake:algo";

  it("infers Réti stake required inputs", () => {
    expect(inferEnterRequiredInputs(RETI_STAKE)).toEqual([
      "userAddress",
      "validatorId",
      "amount",
    ]);
  });

  it("completes increase executionInput from position hints without researched opportunity", () => {
    const held = position({
      protocol: "reti",
      positionType: "staked",
      positionId: "reti:staked:220:99",
      opportunityId: "reti-staking-220",
      assetId: 0,
      assetSymbol: "ALGO",
      amountRaw: "1000000000",
      amount: "1000",
      usdValue: 200,
      compatibleExitShapeKeys: ["mainnet:reti:v1:unstake:algo"],
      inputHints: { validatorId: 220, poolAppId: 99, assetId: 0 },
    });
    const snapshot = portfolioSnapshot({ positions: [held] });

    const completed = completeActionExecutionInput(
      {
        id: "a5",
        type: "increase",
        protocol: "reti",
        opportunityId: null,
        positionId: held.positionId,
        amountRaw: "2500000000",
        fromAssetId: 0,
        toAssetId: null,
        targetWeightPct: null,
        executionShapeKey: RETI_STAKE,
        executionInput: null,
        authorizedSpends: [{ assetId: 0, amountRaw: "2500000000" }],
        rationale: "Top up Réti stake.",
        dependencies: [],
      },
      [],
      snapshot,
    );

    expect(completed.opportunityId).toBe("reti-staking-220");
    expect(completed.executionInput).toMatchObject({
      validatorId: 220,
      poolAppId: 99,
      amount: "2500000000",
    });
  });
});
