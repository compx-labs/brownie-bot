import { describe, expect, it, vi } from "vitest";

import type { Opportunity, PortfolioSnapshot } from "../src/domain.js";
import {
  DeterministicUnwindService,
  UnwindPendingStore,
  fingerprintActions,
  pickNextPositionStep,
  planUnwindWave,
} from "../src/services/deterministic-unwind.js";
import {
  FOLKS_XALGO_ASSET_ID,
  FOLKS_XALGO_UNSTAKE_SHAPE,
} from "../src/services/protocol-verify.js";
import { TINYMAN_FARM_CLAIM_SHAPE } from "../src/services/shape-execution-input.js";
import { RunCoordinator } from "../src/services/run-coordinator.js";
import {
  enterShape,
  opportunity,
  portfolioSnapshot,
  position,
} from "./fixtures.js";

const POOL = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";
const TINY_ASSET = 31_566_704;
const REWARD_POSITION_ID = `tinyman:reward:${POOL}:123456:${TINY_ASSET}`;
const UNCOMMIT_SHAPE = "mainnet:tinyman:staking-v1:farm:uncommit";
const REMOVE_LP_SHAPE = "mainnet:tinyman:v2:removeLiquidity:flexible";
const FOLKS_WITHDRAW = "mainnet:folks-finance:v2:withdraw:escrow";

describe("pickNextPositionStep", () => {
  it("prefers claim, then uncommit, then exit", () => {
    expect(
      pickNextPositionStep(
        position({
          positionType: "reward",
          compatibleExitShapeKeys: [],
          compatibleManageShapeKeys: [TINYMAN_FARM_CLAIM_SHAPE],
        }),
      ),
    ).toEqual({ kind: "claim", shapeKey: TINYMAN_FARM_CLAIM_SHAPE });

    expect(
      pickNextPositionStep(
        position({
          compatibleExitShapeKeys: [REMOVE_LP_SHAPE, UNCOMMIT_SHAPE],
          compatibleManageShapeKeys: [],
        }),
      ),
    ).toEqual({ kind: "uncommit", shapeKey: UNCOMMIT_SHAPE });

    expect(
      pickNextPositionStep(
        position({
          compatibleExitShapeKeys: [REMOVE_LP_SHAPE],
          compatibleManageShapeKeys: [],
        }),
      ),
    ).toEqual({ kind: "close", shapeKey: REMOVE_LP_SHAPE });
  });

  it("returns null when catalogs are empty", () => {
    expect(
      pickNextPositionStep(
        position({
          compatibleExitShapeKeys: [],
          compatibleManageShapeKeys: [],
        }),
      ),
    ).toBeNull();
  });
});

describe("planUnwindWave", () => {
  it("orders claim before LP exit and skips empty catalogs / debt", () => {
    const snapshot = portfolioSnapshot({
      positions: [
        position({
          positionId: REWARD_POSITION_ID,
          positionType: "reward",
          opportunityId: "tinyman:pool:1:farm",
          assetId: TINY_ASSET,
          compatibleExitShapeKeys: [],
          compatibleManageShapeKeys: [TINYMAN_FARM_CLAIM_SHAPE],
        }),
        position({
          positionId: "tinyman:lp:1",
          compatibleExitShapeKeys: [REMOVE_LP_SHAPE, UNCOMMIT_SHAPE],
          compatibleManageShapeKeys: [],
        }),
        position({
          positionId: "folks:usdc:1",
          protocol: "folks-finance",
          positionType: "supplied",
          opportunityId: "folks:usdc",
          assetId: 31_566_704,
          compatibleExitShapeKeys: [FOLKS_WITHDRAW],
          compatibleManageShapeKeys: [],
        }),
        position({
          positionId: "mystery:1",
          compatibleExitShapeKeys: [],
          compatibleManageShapeKeys: [],
        }),
        position({
          positionId: "debt:1",
          positionType: "debt",
          compatibleExitShapeKeys: ["repay"],
          compatibleManageShapeKeys: [],
        }),
      ],
    });

    const plan = planUnwindWave(snapshot, [], { idPrefix: "t" });
    expect(plan.actions.map((action) => action.type)).toEqual([
      "claim",
      "close",
      "close",
    ]);
    expect(plan.actions[0]?.executionShapeKey).toBe(TINYMAN_FARM_CLAIM_SHAPE);
    expect(plan.actions[1]?.executionShapeKey).toBe(UNCOMMIT_SHAPE);
    expect(plan.actions[2]?.executionShapeKey).toBe(FOLKS_WITHDRAW);
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          positionId: "mystery:1",
          reason: "no compatible exit/manage shape keys",
        }),
        expect.objectContaining({
          positionId: "debt:1",
          reason: "debt positions are not auto-unwound",
        }),
      ]),
    );
  });

  it("emits Folks xALGO LST unstake when spendable receipt is present", () => {
    const snapshot = portfolioSnapshot({
      positions: [],
      liquidBalances: [
        {
          assetId: 0,
          amountRaw: "1000000",
          spendableAmountRaw: "900000",
          decimals: 6,
        },
        {
          assetId: FOLKS_XALGO_ASSET_ID,
          amountRaw: "5000000",
          spendableAmountRaw: "5000000",
          decimals: 6,
        },
      ],
    });
    const plan = planUnwindWave(snapshot, [], { idPrefix: "lst" });
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]?.type).toBe("open");
    expect(plan.actions[0]?.executionShapeKey).toBe(FOLKS_XALGO_UNSTAKE_SHAPE);
    expect(plan.actions[0]?.amountRaw).toBe("5000000");
    expect(plan.actions[0]?.authorizedSpends).toEqual([
      { assetId: FOLKS_XALGO_ASSET_ID, amountRaw: "5000000" },
    ]);
  });

  it("fingerprints actions order-independently", () => {
    const snapshot = portfolioSnapshot({
      positions: [
        position({
          positionId: "a",
          compatibleExitShapeKeys: [REMOVE_LP_SHAPE],
        }),
        position({
          positionId: "b",
          protocol: "folks-finance",
          compatibleExitShapeKeys: [FOLKS_WITHDRAW],
        }),
      ],
    });
    const left = planUnwindWave(snapshot, []);
    const right = planUnwindWave(snapshot, []);
    expect(left.fingerprint).toBe(right.fingerprint);
    expect(fingerprintActions([...left.actions].reverse())).toBe(
      left.fingerprint,
    );
  });
});

describe("UnwindPendingStore", () => {
  it("expires and supports take/clear", () => {
    const store = new UnwindPendingStore(1_000);
    const plan = planUnwindWave(portfolioSnapshot({ positions: [] }), []);
    store.set("chat-1", plan, 1_000);
    expect(store.get("chat-1", 1_500)?.actionCount).toBe(0);
    expect(store.get("chat-1", 2_100)).toBeNull();

    store.set("chat-1", plan, 3_000);
    expect(store.take("chat-1", 3_100)?.fingerprint).toBe(plan.fingerprint);
    expect(store.get("chat-1", 3_200)).toBeNull();

    store.set("chat-1", plan, 4_000);
    expect(store.clear("chat-1")).toBe(true);
    expect(store.clear("chat-1")).toBe(false);
  });
});

describe("DeterministicUnwindService.run", () => {
  function folksOpportunity(): Opportunity {
    return opportunity({
      protocol: "folks-finance",
      opportunityId: "folks:usdc",
      assetPair: "USDC",
      assetIds: [31_566_704],
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:folks-finance:v2:deposit:escrow",
          protocol: "folks-finance",
          action: "deposit",
          variant: "escrow",
          requiredInputs: ["amount"],
          requiredAssetIds: [31_566_704],
        }),
      ],
    });
  }

  function snapshotWithFolks(): PortfolioSnapshot {
    return portfolioSnapshot({
      positions: [
        position({
          positionId: "folks:usdc:1",
          protocol: "folks-finance",
          positionType: "supplied",
          opportunityId: "folks:usdc",
          assetId: 31_566_704,
          amountRaw: "1000000",
          compatibleExitShapeKeys: [FOLKS_WITHDRAW],
          compatibleManageShapeKeys: [],
        }),
      ],
    });
  }

  it("stops on empty plan (no-op) and on stuck fingerprint", async () => {
    const emptyReader = {
      read: vi.fn().mockResolvedValue({
        snapshot: portfolioSnapshot({ positions: [] }),
        payments: [],
      }),
    };
    const canix = {
      getPersonalizedOpportunities: vi.fn().mockResolvedValue({
        opportunities: [],
      }),
      getOpportunities: vi.fn().mockResolvedValue({ opportunities: [] }),
    };
    const executor = {
      executeAction: vi.fn(),
    };
    const coordinator = new RunCoordinator();
    const service = new DeterministicUnwindService({
      portfolioReader: emptyReader,
      canix: canix as never,
      walletAddress: "ADDR",
      executor: executor as never,
      coordinator,
      signingEnabled: true,
      isPaused: () => false,
      maxWaves: 3,
    });

    const noOp = await service.run("fail");
    expect(noOp.status).toBe("no-op");
    expect(executor.executeAction).not.toHaveBeenCalled();

    const held = snapshotWithFolks();
    const failingExecutor = {
      executeAction: vi.fn().mockResolvedValue({
        outcome: {
          actionId: "x",
          status: "failed",
          error: "quote failed",
        },
        payments: [],
      }),
    };
    const stuckService = new DeterministicUnwindService({
      portfolioReader: {
        read: vi.fn().mockResolvedValue({ snapshot: held, payments: [] }),
      },
      canix: {
        getPersonalizedOpportunities: vi.fn().mockResolvedValue({
          opportunities: [folksOpportunity()],
        }),
        getOpportunities: vi.fn().mockResolvedValue({ opportunities: [] }),
      } as never,
      walletAddress: "ADDR",
      executor: failingExecutor as never,
      coordinator: new RunCoordinator(),
      signingEnabled: true,
      isPaused: () => false,
      maxWaves: 3,
    });

    const stuck = await stuckService.run("fail");
    expect(stuck.status).toBe("stuck");
    expect(failingExecutor.executeAction).toHaveBeenCalled();
  });

  it("multi-wave completes when second snapshot is empty", async () => {
    const held = snapshotWithFolks();
    const flat = portfolioSnapshot({ positions: [] });
    const reader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ snapshot: held, payments: [] })
        .mockResolvedValueOnce({ snapshot: flat, payments: [] }),
    };
    const executor = {
      executeAction: vi.fn().mockResolvedValue({
        outcome: {
          actionId: "unwind-w1-close-folks:usdc:1",
          status: "confirmed",
          transactionId: "TX1",
        },
        payments: [],
      }),
    };
    const service = new DeterministicUnwindService({
      portfolioReader: reader,
      canix: {
        getPersonalizedOpportunities: vi.fn().mockResolvedValue({
          opportunities: [folksOpportunity()],
        }),
        getOpportunities: vi.fn().mockResolvedValue({ opportunities: [] }),
      } as never,
      walletAddress: "ADDR",
      executor: executor as never,
      coordinator: new RunCoordinator(),
      signingEnabled: true,
      isPaused: () => false,
      maxWaves: 4,
    });

    const result = await service.run("fail");
    expect(result.status).toBe("completed");
    expect(result.waves).toHaveLength(1);
    expect(executor.executeAction).toHaveBeenCalledTimes(1);
  });

  it("refuses when paused or signing disabled", async () => {
    const service = new DeterministicUnwindService({
      portfolioReader: { read: vi.fn() },
      canix: {} as never,
      walletAddress: "ADDR",
      executor: { executeAction: vi.fn() } as never,
      coordinator: new RunCoordinator(),
      signingEnabled: false,
      isPaused: () => false,
    });
    await expect(service.run("fail")).rejects.toThrow(/Signing is disabled/);

    const paused = new DeterministicUnwindService({
      portfolioReader: { read: vi.fn() },
      canix: {} as never,
      walletAddress: "ADDR",
      executor: { executeAction: vi.fn() } as never,
      coordinator: new RunCoordinator(),
      signingEnabled: true,
      isPaused: () => true,
    });
    await expect(paused.run("fail")).rejects.toThrow(/paused/);
  });
});
