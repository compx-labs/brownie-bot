import { describe, expect, it } from "vitest";

import type { PortfolioAction, PortfolioSnapshot } from "../src/domain.js";
import {
  TINYMAN_FARM_CLAIM_SHAPE,
  completeActionExecutionInput,
  inferClaimRequiredInputs,
  parseTinymanFarmNotes,
  parseTinymanRewardPositionId,
  parseTinymanRewardPositionHints,
  resolveShapeForAction,
} from "../src/services/shape-execution-input.js";
import { portfolioSnapshot, position } from "./fixtures.js";

const POOL =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";
const TINY_ASSET = 31_566_704;
const REWARD_POSITION_ID = `tinyman:reward:${POOL}:123456:${TINY_ASSET}`;

function rewardPosition(
  overrides: Parameters<typeof position>[0] = {},
) {
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
  });

  it("does not synthesize claim when executionShapeKey is missing", () => {
    const snapshot = portfolioSnapshot({
      positions: [rewardPosition()],
    });
    const completed = completeActionExecutionInput(
      claimAction({ executionShapeKey: null, executionInput: null }),
      [],
      snapshot,
    );
    expect(completed.executionInput).toBeNull();
  });
});
