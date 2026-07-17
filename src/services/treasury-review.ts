import { randomUUID } from "node:crypto";

import type {
  ExecutionOutcome,
  Opportunity,
  PaymentReceipt,
  PortfolioAction,
  PortfolioPlan,
  PortfolioSnapshot,
  PolicyResult,
  ReviewRun,
} from "../domain.js";
import type { PortfolioAgent } from "./portfolio-agent.js";
import type { CoordinatorMode, RunCoordinator } from "./run-coordinator.js";
import { RunCoordinatorBusyError } from "./run-coordinator.js";
import type { RunNotifier } from "./telegram.js";

export class RunInProgressError extends Error {
  constructor(message = "A treasury review is already running") {
    super(message);
    this.name = "RunInProgressError";
  }
}

export interface ReviewState {
  latest?: ReviewRun;
}

export interface ActionExecutor {
  executeAction(
    action: PortfolioAction,
    context?: { opportunities?: Opportunity[] },
  ): Promise<{
    outcome: ExecutionOutcome;
    payments: PaymentReceipt[];
  }>;
}

export interface PlanValidator {
  validate(
    snapshot: PortfolioSnapshot,
    plan: PortfolioPlan,
    opportunities: Opportunity[],
  ): PolicyResult;
}

export interface SnapshotReader {
  read(): Promise<{
    snapshot: PortfolioSnapshot;
    payments: PaymentReceipt[];
  }>;
}

export class TreasuryReviewService {
  private running = false;

  constructor(
    private readonly agent: PortfolioAgent,
    private readonly policy: PlanValidator,
    private readonly executor: ActionExecutor,
    private readonly notifier: RunNotifier,
    private readonly state: ReviewState,
    private readonly walletAddress: string | undefined,
    private readonly signingEnabled: boolean,
    private readonly portfolioReader?: SnapshotReader,
    private readonly coordinator?: RunCoordinator,
  ) {}

  async run(mode: CoordinatorMode = "wait"): Promise<ReviewRun> {
    if (this.running) {
      throw new RunInProgressError();
    }
    this.running = true;
    try {
      if (this.coordinator) {
        try {
          return await this.coordinator.runExclusive(
            () => this.execute(),
            mode,
          );
        } catch (error) {
          if (error instanceof RunCoordinatorBusyError) {
            throw new RunInProgressError(error.message);
          }
          throw error;
        }
      }
      return await this.execute();
    } finally {
      this.running = false;
    }
  }

  private async execute(): Promise<ReviewRun> {
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    let result: ReviewRun;

    try {
      if (!this.walletAddress) {
        throw new Error(
          "Treasury wallet is not configured; set BOT_WALLET and WALLET_MNEMONIC",
        );
      }
      const agentResult = await this.agent.run();
      const policy = this.policy.validate(
        agentResult.snapshot,
        agentResult.plan,
        agentResult.opportunities,
      );
      const actionable = agentResult.plan.actions.filter(
        (action) => action.type !== "hold",
      );
      const executions: ExecutionOutcome[] = [];
      if (policy.approved && !this.signingEnabled) {
        for (const action of agentResult.plan.actions) {
          executions.push(
            action.type === "hold"
              ? { actionId: action.id, status: "skipped" }
              : { actionId: action.id, status: "validated-dry-run" },
          );
        }
      } else if (policy.approved) {
        for (const action of orderActions(agentResult.plan.actions)) {
          if (action.type === "hold") {
            executions.push({ actionId: action.id, status: "skipped" });
            continue;
          }
          if (
            action.dependencies.some((dependency) => {
              const outcome = executions.find(
                (candidate) => candidate.actionId === dependency,
              );
              return (
                outcome &&
                outcome.status !== "confirmed" &&
                outcome.status !== "validated-dry-run"
              );
            })
          ) {
            executions.push({
              actionId: action.id,
              status: "skipped",
              error: "A dependency did not complete",
            });
            continue;
          }
          const execution = await this.executor.executeAction(action, {
            opportunities: agentResult.opportunities,
          });
          executions.push(execution.outcome);
          agentResult.payments.push(...execution.payments);
        }
      }
      const status = determineStatus(
        actionable.length,
        policy.approved,
        executions,
        this.signingEnabled,
      );
      let reconciledSnapshot: PortfolioSnapshot | undefined;
      let reconciliationError: string | undefined;
      if (
        this.signingEnabled &&
        executions.some((outcome) => outcome.status === "confirmed") &&
        this.portfolioReader
      ) {
        try {
          const reconciliation = await this.portfolioReader.read();
          reconciledSnapshot = reconciliation.snapshot;
          agentResult.payments.push(...reconciliation.payments);
        } catch (error) {
          reconciliationError = safeErrorMessage(error);
        }
      }
      result = {
        id,
        startedAt,
        completedAt: new Date().toISOString(),
        status,
        mode: "autonomous",
        signingEnabled: this.signingEnabled,
        walletAddress: this.walletAddress,
        snapshot: agentResult.snapshot,
        reconciledSnapshot,
        reconciliationError,
        plan: agentResult.plan,
        policy,
        executions,
        opportunities: agentResult.opportunities,
        payments: agentResult.payments,
      };
    } catch (error) {
      const message = safeErrorMessage(error);
      console.error(`[treasury-review] Run failed: ${message}`);
      if (error instanceof Error && error.stack) {
        console.error(error.stack);
      }
      result = {
        id,
        startedAt,
        completedAt: new Date().toISOString(),
        status: "failed",
        mode: "autonomous",
        signingEnabled: this.signingEnabled,
        walletAddress: this.walletAddress,
        opportunities: [],
        error: message,
      };
    }

    try {
      await this.notifier.send(result);
    } catch (error) {
      result.notificationError = safeErrorMessage(error);
    }
    this.state.latest = result;
    return result;
  }
}

function orderActions(actions: PortfolioAction[]): PortfolioAction[] {
  const byId = new Map(actions.map((action) => [action.id, action]));
  const ordered: PortfolioAction[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (action: PortfolioAction) => {
    if (visited.has(action.id)) {
      return;
    }
    if (visiting.has(action.id)) {
      throw new Error(`Action dependency cycle includes ${action.id}`);
    }
    visiting.add(action.id);
    for (const dependency of action.dependencies) {
      const required = byId.get(dependency);
      if (!required) {
        // Missing IDs are reported by policy; skip so dry-run can still proceed.
        continue;
      }
      visit(required);
    }
    visiting.delete(action.id);
    visited.add(action.id);
    ordered.push(action);
  };
  actions.forEach(visit);
  return ordered;
}

function determineStatus(
  actionCount: number,
  approved: boolean,
  executions: ExecutionOutcome[],
  signingEnabled: boolean,
): ReviewRun["status"] {
  if (actionCount === 0) {
    return "no-op";
  }
  if (!approved) {
    return "planned";
  }
  if (!signingEnabled) {
    return executions.some((outcome) =>
      ["failed", "skipped"].includes(outcome.status),
    )
      ? "planned"
      : "validated-dry-run";
  }
  const confirmed = executions.filter(
    (outcome) => outcome.status === "confirmed",
  ).length;
  const failed = executions.some((outcome) =>
    ["failed", "skipped"].includes(outcome.status),
  );
  if (confirmed > 0 && failed) {
    return "partially-executed";
  }
  return confirmed === actionCount ? "confirmed" : "failed";
}

export function rankOpportunities(opportunities: Opportunity[]): Opportunity[] {
  return opportunities
    .map((opportunity, index) => ({ opportunity, index }))
    .sort(
      (left, right) =>
        right.opportunity.apy - left.opportunity.apy ||
        right.opportunity.tvlUsd - left.opportunity.tvlUsd ||
        left.index - right.index,
    )
    .map(({ opportunity }) => opportunity);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
