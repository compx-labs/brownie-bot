import { describe, expect, it, vi } from "vitest";

import type {
  PortfolioAgent,
  PortfolioAgentResult,
} from "../src/services/portfolio-agent.js";
import {
  DEFERRED_DEPENDENT_ACTION_ERROR,
  rankOpportunities,
  RunInProgressError,
  type ActionExecutor,
  type PlanValidator,
  TreasuryReviewService,
} from "../src/services/treasury-review.js";
import type { RunNotifier } from "../src/services/telegram.js";
import type { PortfolioAction } from "../src/domain.js";
import { opportunity, portfolioPlan, portfolioSnapshot } from "./fixtures.js";

function dependencies(agent: PortfolioAgent) {
  const validate = vi.fn().mockReturnValue({
    approved: true,
    violations: [],
    warnings: [],
    metrics: {
      maxPositionPct: 0,
      maxProtocolPct: 0,
      liquidReservePct: 100,
      turnoverPct: 0,
    },
  });
  const executeAction = vi.fn();
  const send = vi.fn();
  const policy: PlanValidator = { validate };
  const executor: ActionExecutor = { executeAction };
  const notifier: RunNotifier = { send };
  return { agent, policy, executor, notifier, validate, executeAction, send };
}

function service(
  agent: PortfolioAgent,
  overrides: Partial<ReturnType<typeof dependencies>> = {},
) {
  const deps = { ...dependencies(agent), ...overrides };
  return {
    instance: new TreasuryReviewService(
      deps.agent,
      deps.policy,
      deps.executor,
      deps.notifier,
      {},
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
      false,
    ),
    deps,
  };
}

describe("rankOpportunities", () => {
  it("sorts by APY, then TVL, while preserving stable ties", () => {
    const low = opportunity({ opportunityId: "low", apy: 4 });
    const smaller = opportunity({
      opportunityId: "smaller",
      apy: 8,
      tvlUsd: 10,
    });
    const larger = opportunity({
      opportunityId: "larger",
      apy: 8,
      tvlUsd: 20,
    });
    const equal = opportunity({
      opportunityId: "equal",
      apy: 8,
      tvlUsd: 20,
    });

    expect(
      rankOpportunities([low, larger, equal, smaller]).map(
        (item) => item.opportunityId,
      ),
    ).toEqual(["larger", "equal", "smaller", "low"]);
  });
});

describe("TreasuryReviewService", () => {
  it("prevents overlapping runs", async () => {
    let release: (() => void) | undefined;
    const agent: PortfolioAgent = {
      run: vi.fn(
        () =>
          new Promise<PortfolioAgentResult>((resolve) => {
            release = () =>
              resolve({
                snapshot: portfolioSnapshot(),
                plan: portfolioPlan(),
                opportunities: [],
                payments: [],
                toolCalls: [],
              });
          }),
      ),
    };
    const { instance } = service(agent);

    const first = instance.run();
    await expect(instance.run()).rejects.toBeInstanceOf(RunInProgressError);
    release?.();
    await expect(first).resolves.toMatchObject({ status: "no-op" });
  });

  it("retains a completed run in memory when notification fails", async () => {
    const state = {};
    const agent: PortfolioAgent = {
      run: vi.fn().mockResolvedValue({
        snapshot: portfolioSnapshot(),
        plan: portfolioPlan(),
        opportunities: [],
        payments: [],
        toolCalls: [],
      }),
    };
    const notifier: RunNotifier = {
      send: vi.fn().mockRejectedValue(new Error("Telegram unavailable")),
    };
    const putLatest = vi.fn().mockResolvedValue("key");
    const deps = dependencies(agent);
    const instance = new TreasuryReviewService(
      deps.agent,
      deps.policy,
      deps.executor,
      notifier,
      state,
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
      false,
      undefined,
      undefined,
      { getLatest: vi.fn(), putLatest },
    );

    const result = await instance.run();
    expect(result).toMatchObject({
      status: "no-op",
      notificationError: "Telegram unavailable",
    });
    expect(state).toHaveProperty("latest", result);
    expect(putLatest).toHaveBeenCalledWith(
      expect.objectContaining({
        notificationError: "Telegram unavailable",
      }),
    );
  });

  it("keeps the run successful when persistence fails", async () => {
    const agent: PortfolioAgent = {
      run: vi.fn().mockResolvedValue({
        snapshot: portfolioSnapshot(),
        plan: portfolioPlan(),
        opportunities: [],
        payments: [],
        toolCalls: [],
      }),
    };
    const putLatest = vi
      .fn()
      .mockRejectedValue(new Error("Spaces unavailable"));
    const deps = dependencies(agent);
    const state = {};
    const reviewService = new TreasuryReviewService(
      deps.agent,
      deps.policy,
      deps.executor,
      deps.notifier,
      state,
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
      false,
      undefined,
      undefined,
      { getLatest: vi.fn(), putLatest },
    );

    const result = await reviewService.run();
    expect(result.status).toBe("no-op");
    expect(state).toHaveProperty("latest", result);
    expect(putLatest).toHaveBeenCalledOnce();
  });

  it("fails closed when the portfolio agent fails", async () => {
    const agent: PortfolioAgent = {
      run: vi.fn().mockRejectedValue(new Error("Invalid AI plan")),
    };
    const { instance } = service(agent);

    await expect(instance.run()).resolves.toMatchObject({
      status: "failed",
      error: "Invalid AI plan",
    });
  });

  it("reports unstructured agent output without failing the run", async () => {
    const agent: PortfolioAgent = {
      run: vi.fn().mockResolvedValue({
        snapshot: portfolioSnapshot(),
        planRawText: "Useful narrative plan without schema.",
        planParseError: "invalid structured plan: summary: Required",
        opportunities: [],
        payments: [],
        toolCalls: ["canix_get_positions"],
      }),
    };
    const { instance, deps } = service(agent);

    await expect(instance.run()).resolves.toMatchObject({
      status: "reported",
      planRawText: "Useful narrative plan without schema.",
      planParseError: "invalid structured plan: summary: Required",
    });
    expect(deps.send).toHaveBeenCalledOnce();
    expect(deps.send).toHaveBeenCalledWith(
      expect.objectContaining({ status: "reported" }),
    );
    expect(deps.validate).not.toHaveBeenCalled();
    expect(deps.executeAction).not.toHaveBeenCalled();
  });

  it("sanitizes HTML gateway timeouts from the portfolio agent", async () => {
    const agent: PortfolioAgent = {
      run: vi.fn().mockRejectedValue(
        new Error(
          `504 <!DOCTYPE html><html><title>504 Gateway Timeout</title><h3>We could not establish a connection to nauvoo.belt.algo.xyz</h3></html>`,
        ),
      ),
    };
    const { instance } = service(agent);

    await expect(instance.run()).resolves.toMatchObject({
      status: "failed",
      error:
        "ZeroSignal gateway timeout (504); could not reach nauvoo.belt.algo.xyz",
    });
  });

  it("does not call the executor when signing is disabled", async () => {
    const action = {
      id: "open-1",
      type: "open" as const,
      protocol: "tinyman",
      opportunityId: "tinyman:pool:1",
      positionId: null,
      amountRaw: "100000000",
      fromAssetId: 31_566_704,
      toAssetId: null,
      targetWeightPct: 10,
      executionShapeKey: "tinyman:open",
      executionInput: {},
      authorizedSpends: [{ assetId: 31_566_704, amountRaw: "100000000" }],
      rationale: "Test",
      dependencies: [],
    };
    const agent: PortfolioAgent = {
      run: vi.fn().mockResolvedValue({
        snapshot: portfolioSnapshot(),
        plan: portfolioPlan({ actions: [action], projectedNetBenefitUsd: 5 }),
        opportunities: [opportunity()],
        payments: [],
        toolCalls: ["canix_list_opportunities"],
      }),
    };
    const executeAction = vi.fn();
    const { instance } = service(agent, {
      executor: { executeAction },
    });

    await expect(instance.run()).resolves.toMatchObject({
      status: "validated-dry-run",
      executions: [{ actionId: "open-1", status: "validated-dry-run" }],
    });
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("stops before execution when deterministic policy rejects the plan", async () => {
    const action = {
      id: "open-1",
      type: "open" as const,
      protocol: "tinyman",
      opportunityId: "tinyman:pool:1",
      positionId: null,
      amountRaw: "100000000",
      fromAssetId: 31_566_704,
      toAssetId: null,
      targetWeightPct: 10,
      executionShapeKey: "tinyman:open",
      executionInput: {},
      authorizedSpends: [{ assetId: 31_566_704, amountRaw: "100000000" }],
      rationale: "Test",
      dependencies: [],
    };
    const agent: PortfolioAgent = {
      run: vi.fn().mockResolvedValue({
        snapshot: portfolioSnapshot(),
        plan: portfolioPlan({ actions: [action], projectedNetBenefitUsd: 5 }),
        opportunities: [opportunity()],
        payments: [],
        toolCalls: ["canix_list_opportunities"],
      }),
    };
    const policy: PlanValidator = {
      validate: vi.fn().mockReturnValue({
        approved: false,
        violations: ["Action open-1 has no executable shape"],
        warnings: ["Target position 50% exceeds guidance of 35%"],
        metrics: {
          maxPositionPct: 50,
          maxProtocolPct: 50,
          liquidReservePct: 50,
          turnoverPct: 10,
        },
      }),
    };
    const executeAction = vi.fn();
    const { instance } = service(agent, {
      policy,
      executor: { executeAction },
    });

    await expect(instance.run()).resolves.toMatchObject({
      status: "planned",
      policy: { approved: false },
    });
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("re-reads the on-chain portfolio after confirmed execution", async () => {
    const plannedSnapshot = portfolioSnapshot({
      fetchedAt: "2026-07-14T08:00:00.000Z",
    });
    const reconciledSnapshot = portfolioSnapshot({
      fetchedAt: "2026-07-14T08:05:00.000Z",
    });
    const action = {
      id: "swap-1",
      type: "swap" as const,
      protocol: null,
      opportunityId: null,
      positionId: null,
      amountRaw: "1000000",
      fromAssetId: 31_566_704,
      toAssetId: 0,
      targetWeightPct: null,
      executionShapeKey: null,
      executionInput: null,
      authorizedSpends: [{ assetId: 31_566_704, amountRaw: "1000000" }],
      rationale: "Rebalance.",
      dependencies: [],
    };
    const agent: PortfolioAgent = {
      run: vi.fn().mockResolvedValue({
        snapshot: plannedSnapshot,
        plan: portfolioPlan({ actions: [action], projectedNetBenefitUsd: 5 }),
        opportunities: [],
        payments: [],
        toolCalls: ["canix_list_opportunities"],
      }),
    };
    const deps = dependencies(agent);
    const readPortfolio = vi.fn().mockResolvedValue({
      snapshot: reconciledSnapshot,
      payments: [],
    });
    const portfolioReader = { read: readPortfolio };
    const instance = new TreasuryReviewService(
      deps.agent,
      deps.policy,
      {
        executeAction: vi.fn().mockResolvedValue({
          outcome: {
            actionId: action.id,
            status: "confirmed",
            transactionId: "TXID",
          },
          payments: [],
        }),
      },
      deps.notifier,
      {},
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
      true,
      portfolioReader,
    );

    await expect(instance.run()).resolves.toMatchObject({
      status: "confirmed",
      reconciledSnapshot,
    });
    expect(readPortfolio).toHaveBeenCalledOnce();
  });

  it("executes only foundation (no-dependency) actions when signing", async () => {
    const reduce = {
      id: "reduce-1",
      type: "reduce" as const,
      protocol: "tinyman",
      opportunityId: "tinyman:pool:1",
      positionId: "pos-1",
      amountRaw: "1000",
      fromAssetId: 1,
      toAssetId: 31_566_704,
      targetWeightPct: null,
      executionShapeKey: "tinyman:reduce",
      executionInput: {},
      authorizedSpends: [],
      rationale: "Free USDC.",
      dependencies: [],
    };
    const swap = {
      id: "swap-1",
      type: "swap" as const,
      protocol: null,
      opportunityId: null,
      positionId: null,
      amountRaw: "1000000",
      fromAssetId: 31_566_704,
      toAssetId: 0,
      targetWeightPct: null,
      executionShapeKey: null,
      executionInput: null,
      authorizedSpends: [{ assetId: 31_566_704, amountRaw: "1000000" }],
      rationale: "USDC to ALGO.",
      dependencies: ["reduce-1"],
    };
    const open = {
      id: "open-1",
      type: "open" as const,
      protocol: "reti",
      opportunityId: "reti:1",
      positionId: null,
      amountRaw: "1000000",
      fromAssetId: 0,
      toAssetId: null,
      targetWeightPct: 10,
      executionShapeKey: "reti:stake",
      executionInput: {},
      authorizedSpends: [{ assetId: 0, amountRaw: "1000000" }],
      rationale: "Stake ALGO.",
      dependencies: ["swap-1"],
    };
    const agent: PortfolioAgent = {
      run: vi.fn().mockResolvedValue({
        snapshot: portfolioSnapshot(),
        plan: portfolioPlan({
          actions: [reduce, swap, open],
          projectedNetBenefitUsd: 5,
        }),
        opportunities: [opportunity()],
        payments: [],
        toolCalls: [],
      }),
    };
    const executeAction = vi.fn().mockResolvedValue({
      outcome: {
        actionId: "reduce-1",
        status: "confirmed",
        transactionId: "TX-REDUCE",
      },
      payments: [],
    });
    const deps = dependencies(agent);
    const instance = new TreasuryReviewService(
      deps.agent,
      deps.policy,
      { executeAction },
      deps.notifier,
      {},
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
      true,
    );

    const result = await instance.run();
    expect(result.status).toBe("partially-executed");
    expect(result.executions).toEqual([
      {
        actionId: "reduce-1",
        status: "confirmed",
        transactionId: "TX-REDUCE",
      },
      {
        actionId: "swap-1",
        status: "skipped",
        error: DEFERRED_DEPENDENT_ACTION_ERROR,
      },
      {
        actionId: "open-1",
        status: "skipped",
        error: DEFERRED_DEPENDENT_ACTION_ERROR,
      },
    ]);
    expect(executeAction).toHaveBeenCalledOnce();
    expect(executeAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "reduce-1" }),
      expect.anything(),
    );
  });

  it("still executes independent no-dependency actions together", async () => {
    const claim = {
      id: "claim-1",
      type: "claim" as const,
      protocol: "tinyman",
      opportunityId: "tinyman:farm:1",
      positionId: "farm-1",
      amountRaw: null,
      fromAssetId: null,
      toAssetId: null,
      targetWeightPct: null,
      executionShapeKey: "tinyman:claim",
      executionInput: {},
      authorizedSpends: [],
      rationale: "Claim rewards.",
      dependencies: [],
    };
    const reduce = {
      id: "reduce-1",
      type: "reduce" as const,
      protocol: "tinyman",
      opportunityId: "tinyman:pool:1",
      positionId: "pos-1",
      amountRaw: "1000",
      fromAssetId: 1,
      toAssetId: 31_566_704,
      targetWeightPct: null,
      executionShapeKey: "tinyman:reduce",
      executionInput: {},
      authorizedSpends: [],
      rationale: "Free USDC.",
      dependencies: [],
    };
    const agent: PortfolioAgent = {
      run: vi.fn().mockResolvedValue({
        snapshot: portfolioSnapshot(),
        plan: portfolioPlan({
          actions: [claim, reduce],
          projectedNetBenefitUsd: 5,
        }),
        opportunities: [],
        payments: [],
        toolCalls: [],
      }),
    };
    const executeAction = vi.fn().mockImplementation((action: PortfolioAction) =>
      Promise.resolve({
        outcome: {
          actionId: action.id,
          status: "confirmed",
          transactionId: `TX-${action.id}`,
        },
        payments: [],
      }),
    );
    const deps = dependencies(agent);
    const instance = new TreasuryReviewService(
      deps.agent,
      deps.policy,
      { executeAction },
      deps.notifier,
      {},
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
      true,
    );

    const result = await instance.run();
    expect(result.status).toBe("confirmed");
    expect(executeAction).toHaveBeenCalledTimes(2);
    expect(result.executions?.map((item) => item.actionId).sort()).toEqual([
      "claim-1",
      "reduce-1",
    ]);
  });

  it("dry-run still validates the full dependency chain without deferred skips", async () => {
    const swap = {
      id: "swap-1",
      type: "swap" as const,
      protocol: null,
      opportunityId: null,
      positionId: null,
      amountRaw: "1000000",
      fromAssetId: 31_566_704,
      toAssetId: 0,
      targetWeightPct: null,
      executionShapeKey: null,
      executionInput: null,
      authorizedSpends: [{ assetId: 31_566_704, amountRaw: "1000000" }],
      rationale: "USDC to ALGO.",
      dependencies: [],
    };
    const open = {
      id: "open-1",
      type: "open" as const,
      protocol: "reti",
      opportunityId: "reti:1",
      positionId: null,
      amountRaw: "1000000",
      fromAssetId: 0,
      toAssetId: null,
      targetWeightPct: 10,
      executionShapeKey: "reti:stake",
      executionInput: {},
      authorizedSpends: [{ assetId: 0, amountRaw: "1000000" }],
      rationale: "Stake ALGO.",
      dependencies: ["swap-1"],
    };
    const agent: PortfolioAgent = {
      run: vi.fn().mockResolvedValue({
        snapshot: portfolioSnapshot(),
        plan: portfolioPlan({
          actions: [swap, open],
          projectedNetBenefitUsd: 5,
        }),
        opportunities: [opportunity()],
        payments: [],
        toolCalls: [],
      }),
    };
    const executeAction = vi.fn();
    const { instance } = service(agent, {
      executor: { executeAction },
    });

    await expect(instance.run()).resolves.toMatchObject({
      status: "validated-dry-run",
      executions: [
        { actionId: "swap-1", status: "validated-dry-run" },
        { actionId: "open-1", status: "validated-dry-run" },
      ],
    });
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("passes priorReview from state.latest into the agent", async () => {
    const prior = {
      id: "prior-run",
      startedAt: "2026-07-30T12:00:00.000Z",
      completedAt: "2026-07-30T12:01:00.000Z",
      status: "partially-executed" as const,
      mode: "autonomous" as const,
      signingEnabled: true,
      walletAddress: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
      plan: portfolioPlan({
        actions: [
          {
            id: "reduce-1",
            type: "reduce" as const,
            protocol: "tinyman",
            opportunityId: "tinyman:pool:1",
            positionId: "pos-1",
            amountRaw: "1000",
            fromAssetId: 1,
            toAssetId: 31_566_704,
            targetWeightPct: null,
            executionShapeKey: "tinyman:reduce",
            executionInput: {},
            authorizedSpends: [],
            rationale: "Free USDC.",
            dependencies: [],
          },
        ],
      }),
      executions: [
        {
          actionId: "reduce-1",
          status: "confirmed" as const,
          transactionId: "TX-PRIOR",
        },
        {
          actionId: "swap-1",
          status: "skipped" as const,
          error: DEFERRED_DEPENDENT_ACTION_ERROR,
        },
      ],
      opportunities: [],
    };
    const run = vi.fn().mockResolvedValue({
      snapshot: portfolioSnapshot(),
      plan: portfolioPlan(),
      opportunities: [],
      payments: [],
      toolCalls: [],
    });
    const agent: PortfolioAgent = { run };
    const deps = dependencies(agent);
    const instance = new TreasuryReviewService(
      deps.agent,
      deps.policy,
      deps.executor,
      deps.notifier,
      { latest: prior },
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
      false,
    );

    await instance.run();
    expect(run).toHaveBeenCalledWith({
      priorReview: {
        id: "prior-run",
        status: "partially-executed",
        completedAt: "2026-07-30T12:01:00.000Z",
        actions: [
          {
            actionId: "reduce-1",
            type: "reduce",
            protocol: "tinyman",
            status: "confirmed",
            transactionId: "TX-PRIOR",
          },
          {
            actionId: "swap-1",
            status: "skipped",
            error: DEFERRED_DEPENDENT_ACTION_ERROR,
          },
        ],
      },
    });
  });
});
