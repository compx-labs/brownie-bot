import { z } from "zod";

import type { Opportunity, PortfolioAction } from "../../domain.js";

/**
 * Published Canix OpenAPI (`info.version` 1.0.0 on canix402-api.compx.io,
 * 2026-08-20) plus compose step kinds from canix402#83 / NEO-56. Live OpenAPI
 * types `PlanData.allocations[]` as untyped objects; this parser is the
 * Brownie contract for `canix_get_plan` / `POST /plans`.
 */
export const CANIX_PLANS_OPENAPI_VERSION = "1.0.0";
export const CANIX_PLANS_COMPOSE_ORIGIN = "canix402#83";

export const PLAN_COMPILER_X402_USDC = "0.25";
export const PLAN_COMPILER_CEILING_BASE_UNITS = 250_000n;

const HAYSTACK_SHAPE_KEY = /haystack/i;
const STALE_OR_MISSING_OPTIN =
  /stale quote|quote expired|missing opt-?in|opt-?in required|opt-?in missing/i;

const planBudgetSchema = z.object({
  assetId: z.number().int().nonnegative(),
  amount: z.string().regex(/^[1-9][0-9]*$/),
});

const planConstraintsSchema = z
  .object({
    maxProtocolWeightBps: z.number().int().min(1).max(10_000).optional(),
    noNewBorrows: z.boolean().optional(),
    executionReadyOnly: z.boolean().optional(),
    minTvlUsd: z.number().nonnegative().optional(),
    maxSourceAgeSeconds: z.number().int().nonnegative().optional(),
    maxAllocations: z.number().int().min(1).max(10).optional(),
  })
  .strict();

export const planRequestSchema = z.object({
  address: z.string().min(1),
  budget: planBudgetSchema,
  constraints: planConstraintsSchema.optional(),
  opportunityIds: z.array(z.string().min(1)).min(1).max(25).optional(),
  refresh: z.boolean().optional(),
});

export type PlanRequest = z.infer<typeof planRequestSchema>;
export type PlanBudget = z.infer<typeof planBudgetSchema>;
export type PlanConstraints = z.infer<typeof planConstraintsSchema>;

const encodedQuoteSchema = z
  .object({
    shapeKey: z.string().min(1).optional(),
    expiresAt: z.iso.datetime(),
    encodedTransactions: z.array(z.string().min(1)).min(1),
    warnings: z.array(z.string()).default([]),
    transactions: z.array(z.unknown()).default([]),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const walletlessMemberSchema = z
  .object({
    index: z.number().int().nonnegative().optional(),
    encodedTransaction: z.string().min(1),
    signedTransaction: z.string().min(1).optional(),
    signer: z.enum(["user", "haystack"]).optional(),
  })
  .passthrough();

const walletlessGroupSchema = z
  .object({
    required: z.boolean().optional(),
    transactions: z.array(walletlessMemberSchema).min(1),
    userSignIndexes: z.array(z.number().int().nonnegative()).optional(),
    createdAt: z.iso.datetime().optional(),
    quoteExpiresAt: z.iso.datetime().optional(),
    expiresAt: z.iso.datetime().optional(),
  })
  .passthrough();

const planStepSchema = z
  .object({
    kind: z.string().min(1),
    order: z.number().int().nonnegative().optional(),
    compileStatus: z.enum(["compiled", "failed", "skipped"]).optional(),
    shapeKey: z.string().optional(),
    warnings: z.array(z.string()).default([]),
    quote: z.unknown().optional(),
    quoteRequest: z.unknown().optional(),
    group: z.unknown().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

const planQuoteHintSchema = z
  .object({
    shapeKey: z.string().min(1),
    input: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const planAllocationSchema = z
  .object({
    opportunityId: z.string().min(1),
    protocol: z.string().min(1).optional(),
    blocked: z.boolean().optional(),
    quotes: z.array(planQuoteHintSchema).default([]),
    steps: z.array(planStepSchema).default([]),
    warnings: z.array(z.string()).default([]),
  })
  .passthrough();

const planBlockedSchema = z
  .object({
    opportunityId: z.string().optional(),
    reason: z.string().optional(),
    warnings: z.array(z.string()).optional(),
  })
  .passthrough();

export const planResponseSchema = z.object({
  data: z.object({
    allocations: z.array(planAllocationSchema),
    blocked: z.array(planBlockedSchema).default([]),
    expectedPositionDelta: z.unknown().optional(),
    fees: z.unknown().optional(),
    expiresAt: z.iso.datetime(),
    warnings: z.array(z.string()).default([]),
  }),
  meta: z.object({
    address: z.string().min(1),
    budget: planBudgetSchema.partial().optional(),
    fetchedAt: z.iso.datetime(),
    paymentRequired: z.boolean().optional(),
    executionSubmitted: z.literal(false),
    quoteTimeAuthoritative: z.boolean().optional(),
    eligibilityEndpoint: z.string().optional(),
  }),
});

export type PlanResponse = z.infer<typeof planResponseSchema>;
export type PlanAllocation = z.infer<typeof planAllocationSchema>;

export type CompiledPlanKind = "optin" | "swap" | "setup" | "enter";

export interface CompiledPlanMember {
  index: number;
  encoded: string;
  signer: "user" | "haystack";
  signed?: string;
}

export interface CompiledPlanGroup {
  kind: CompiledPlanKind;
  order: number;
  shapeKey?: string;
  expiresAt: string;
  warnings: string[];
  metadata?: Record<string, unknown>;
  encodedTransactions: string[];
  members: CompiledPlanMember[];
  userSignIndexes: number[];
}

export interface PlanCompilePolicy {
  maxProtocolPct: number;
  minTvlUsd: number;
  maxSourceAgeHours: number;
  noNewBorrows?: boolean;
  executionReadyOnly?: boolean;
}

export interface PlanBudgetSource {
  fromAssetId: number | null;
  amountRaw: string | null;
  authorizedSpends: Array<{ assetId: number; amountRaw: string }>;
  dependencies: string[];
}

export function uniqueEnterAssetId(opportunity: Opportunity): number | null {
  const selected = opportunity.executionShapes.filter(
    (shape) =>
      !/unstake|redeem|removeLiquidity|withdraw|burn|claim/i.test(
        `${shape.shapeKey}:${shape.action}:${shape.variant}`,
      ) &&
      !/setup|optin|create|deployescrow/i.test(shape.action) &&
      !/setup|opt|deployescrow/i.test(shape.variant),
  );
  const ids = [
    ...new Set(
      (selected.length > 0 ? selected : opportunity.executionShapes).flatMap(
        (shape) => shape.requiredAssetIds,
      ),
    ),
  ];
  return ids.length === 1 ? (ids[0] ?? null) : null;
}

export function isFoundationSwapFeedingEnter(
  swap: PortfolioAction,
  actions: PortfolioAction[],
): boolean {
  if (swap.type !== "swap" || swap.dependencies.length > 0) {
    return false;
  }
  return actions.some(
    (candidate) =>
      (candidate.type === "open" || candidate.type === "increase") &&
      candidate.dependencies.includes(swap.id),
  );
}

export function enterUsesComposeSwapDeps(
  action: PortfolioAction,
  actions: PortfolioAction[],
): boolean {
  if (action.type !== "open" && action.type !== "increase") {
    return false;
  }
  if (action.dependencies.length === 0) {
    return true;
  }
  return action.dependencies.every((dependency) => {
    const required = actions.find((candidate) => candidate.id === dependency);
    return (
      required?.type === "swap" &&
      required.dependencies.length === 0 &&
      isFoundationSwapFeedingEnter(required, actions)
    );
  });
}

export function resolvePlanBudget(
  action: PlanBudgetSource,
  planActions: PortfolioAction[] = [],
): PlanBudget {
  const feedingSwaps = action.dependencies
    .map((id) => planActions.find((candidate) => candidate.id === id))
    .filter(
      (candidate): candidate is PortfolioAction =>
        candidate?.type === "swap" &&
        candidate.dependencies.length === 0 &&
        candidate.fromAssetId !== null &&
        typeof candidate.amountRaw === "string",
    );
  if (feedingSwaps.length === 1) {
    const swap = feedingSwaps[0]!;
    return {
      assetId: swap.fromAssetId!,
      amount: swap.amountRaw!,
    };
  }
  if (action.fromAssetId !== null && action.amountRaw) {
    return { assetId: action.fromAssetId, amount: action.amountRaw };
  }
  const spend = action.authorizedSpends[0];
  if (spend) {
    return { assetId: spend.assetId, amount: spend.amountRaw };
  }
  throw new Error(
    "Canix plan request is missing a budget asset/amount for the allocation intent",
  );
}

export function buildPlanRequest(input: {
  address: string;
  action: PlanBudgetSource & { opportunityId: string | null };
  planActions?: PortfolioAction[];
  policy: PlanCompilePolicy;
  budgetOverride?: PlanBudget;
}): PlanRequest {
  if (!input.action.opportunityId) {
    throw new Error("Canix plan request requires an opportunityId");
  }
  const budget =
    input.budgetOverride ??
    resolvePlanBudget(input.action, input.planActions ?? []);
  return planRequestSchema.parse({
    address: input.address,
    budget,
    constraints: {
      maxProtocolWeightBps: Math.min(
        10_000,
        Math.max(1, Math.round(input.policy.maxProtocolPct * 100)),
      ),
      noNewBorrows: input.policy.noNewBorrows ?? true,
      executionReadyOnly: input.policy.executionReadyOnly ?? true,
      minTvlUsd: input.policy.minTvlUsd,
      maxSourceAgeSeconds: Math.round(input.policy.maxSourceAgeHours * 3_600),
      maxAllocations: 1,
    },
    opportunityIds: [input.action.opportunityId],
  });
}

export function assertComposablePlan(
  plan: PlanResponse,
  expected: { address: string; opportunityId: string },
): CompiledPlanGroup[] {
  if (plan.meta.executionSubmitted !== false) {
    throw new Error("Canix plan meta.executionSubmitted must be false");
  }
  if (plan.meta.address !== expected.address) {
    throw new Error("Canix plan response address does not match request");
  }
  assertFreshPlan(plan.data.expiresAt, "plan");
  assertNoFailClosedWarnings(plan.data.warnings, "plan");

  const blocked = plan.data.blocked.find(
    (item) => item.opportunityId === expected.opportunityId,
  );
  if (blocked) {
    throw new Error(
      `Canix plan blocked ${expected.opportunityId}${
        blocked.reason ? `: ${blocked.reason}` : ""
      }`,
    );
  }

  const allocation = plan.data.allocations.find(
    (item) => item.opportunityId === expected.opportunityId,
  );
  if (!allocation) {
    throw new Error(
      `Canix plan did not return allocation ${expected.opportunityId}`,
    );
  }
  if (allocation.blocked) {
    throw new Error(
      `Canix plan blocked allocation ${expected.opportunityId} (fail closed)`,
    );
  }
  assertNoFailClosedWarnings(allocation.warnings, allocation.opportunityId);
  assertQuotesHaveNoSyntheticHaystack(allocation);

  const groups = extractCompiledGroups(allocation);
  if (groups.length === 0) {
    throw new Error(
      "Canix plan returned no unsigned executable groups (fail closed; will not assemble swap-then-enter locally)",
    );
  }
  for (const group of groups) {
    assertCompiledGroup(group);
  }
  return groups;
}

export function extractCompiledGroups(
  allocation: PlanAllocation,
): CompiledPlanGroup[] {
  const steps = [...allocation.steps].sort(
    (left, right) => (left.order ?? 0) - (right.order ?? 0),
  );
  const groups: CompiledPlanGroup[] = [];
  for (const [index, step] of steps.entries()) {
    const kind = normalizeStepKind(step.kind);
    if (kind === "eligibility") {
      assertStepCompileStatus(step, kind);
      assertNoFailClosedWarnings(step.warnings, `step ${kind}`);
      continue;
    }
    if (!kind) {
      throw new Error(
        `Canix plan step has unsupported kind ${JSON.stringify(step.kind)}`,
      );
    }
    assertStepCompileStatus(step, kind);
    assertNoFailClosedWarnings(step.warnings, `step ${kind}`);
    const group = compileStepGroup(step, kind, index);
    if (group) {
      groups.push(group);
    }
  }
  return groups;
}

function compileStepGroup(
  step: z.infer<typeof planStepSchema>,
  kind: CompiledPlanKind,
  fallbackOrder: number,
): CompiledPlanGroup | undefined {
  const quote = encodedQuoteSchema.safeParse(step.quote);
  if (quote.success) {
    return compiledFromEncodedQuote(kind, step, quote.data, fallbackOrder);
  }
  const nestedQuote = encodedQuoteSchema.safeParse(
    step.data && typeof step.data === "object"
      ? (step.data as Record<string, unknown>).quote
      : undefined,
  );
  if (nestedQuote.success) {
    return compiledFromEncodedQuote(
      kind,
      step,
      nestedQuote.data,
      fallbackOrder,
    );
  }

  const groupSource = firstDefined(step.group, step.data, step.quote);
  const group = walletlessGroupSchema.safeParse(groupSource);
  if (group.success) {
    if (kind === "optin" && group.data.required === false) {
      return undefined;
    }
    if (
      kind === "optin" &&
      group.data.required === true &&
      group.data.transactions.length === 0
    ) {
      throw new Error(
        "Canix plan opt-in is required but returned no transactions",
      );
    }
    return compiledFromWalletlessGroup(kind, step, group.data, fallbackOrder);
  }

  if (kind === "optin") {
    throw new Error(
      "Canix plan opt-in step is missing an unsigned group (fail closed)",
    );
  }
  throw new Error(
    `Canix plan ${kind} step is missing unsigned transactions (fail closed; will not merge or requote locally)`,
  );
}

function compiledFromEncodedQuote(
  kind: CompiledPlanKind,
  step: z.infer<typeof planStepSchema>,
  quote: z.infer<typeof encodedQuoteSchema>,
  fallbackOrder: number,
): CompiledPlanGroup {
  assertNoFailClosedWarnings(quote.warnings, `${kind} quote`);
  const members: CompiledPlanMember[] = quote.encodedTransactions.map(
    (encoded, index) => ({
      index,
      encoded,
      signer: "user",
    }),
  );
  return {
    kind,
    order: step.order ?? fallbackOrder,
    shapeKey: step.shapeKey ?? quote.shapeKey,
    expiresAt: quote.expiresAt,
    warnings: [...step.warnings, ...quote.warnings],
    metadata: quote.metadata,
    encodedTransactions: quote.encodedTransactions,
    members,
    userSignIndexes: members.map((member) => member.index),
  };
}

function compiledFromWalletlessGroup(
  kind: CompiledPlanKind,
  step: z.infer<typeof planStepSchema>,
  group: z.infer<typeof walletlessGroupSchema>,
  fallbackOrder: number,
): CompiledPlanGroup {
  const expiresAt = group.quoteExpiresAt ?? group.expiresAt;
  if (!expiresAt) {
    throw new Error(`Canix plan ${kind} group is missing expiry`);
  }
  const members: CompiledPlanMember[] = group.transactions.map(
    (transaction, index) => {
      const signer =
        transaction.signer ??
        (transaction.signedTransaction ? "haystack" : "user");
      return {
        index: transaction.index ?? index,
        encoded: transaction.encodedTransaction,
        signer,
        signed: transaction.signedTransaction,
      };
    },
  );
  const userSignIndexes =
    group.userSignIndexes ??
    members
      .filter((member) => member.signer === "user")
      .map((member) => member.index);
  return {
    kind,
    order: step.order ?? fallbackOrder,
    shapeKey: step.shapeKey,
    expiresAt,
    warnings: step.warnings,
    encodedTransactions: members.map((member) => member.encoded),
    members,
    userSignIndexes,
  };
}

function assertCompiledGroup(group: CompiledPlanGroup): void {
  assertFreshPlan(group.expiresAt, group.kind);
  assertNoFailClosedWarnings(group.warnings, group.kind);
  if (group.encodedTransactions.length === 0) {
    throw new Error(`Canix plan ${group.kind} group has no transactions`);
  }
  const userIndexes = new Set(group.userSignIndexes);
  for (const member of group.members) {
    if (member.signer === "haystack") {
      if (!member.signed) {
        throw new Error(
          "Haystack transaction is missing its provider signature",
        );
      }
      if (userIndexes.has(member.index)) {
        throw new Error(
          "Canix plan Haystack signer index overlaps a user-sign index",
        );
      }
    } else if (!userIndexes.has(member.index)) {
      throw new Error(
        `Canix plan user transaction at index ${member.index} is missing from userSignIndexes`,
      );
    }
  }
  if (
    (group.kind === "enter" || group.kind === "setup") &&
    group.members.some(
      (member) => member.signer === "haystack" || member.signed,
    )
  ) {
    throw new Error(
      "Canix plan enter/setup group includes Haystack-signed members; refusing a merged swap+enter group",
    );
  }
}

function assertQuotesHaveNoSyntheticHaystack(allocation: PlanAllocation): void {
  const haystack = allocation.quotes.filter((quote) =>
    HAYSTACK_SHAPE_KEY.test(quote.shapeKey),
  );
  if (haystack.length > 0) {
    throw new Error(
      "Canix plan quotes[] includes synthetic Haystack keys; refusing to treat swap legs as enter quotes",
    );
  }
}

function assertStepCompileStatus(
  step: z.infer<typeof planStepSchema>,
  kind: string,
): void {
  if (step.compileStatus === "failed") {
    throw new Error(
      `Canix plan ${kind} step failed to compile (fail closed; will not assemble a local group)`,
    );
  }
  if (kind !== "eligibility" && step.compileStatus === "skipped") {
    throw new Error(
      `Canix plan ${kind} step was skipped (fail closed; missing opt-in or swap was not composed)`,
    );
  }
}

function assertNoFailClosedWarnings(warnings: string[], label: string): void {
  const hit = warnings.find((warning) => STALE_OR_MISSING_OPTIN.test(warning));
  if (hit) {
    throw new Error(`Canix plan ${label} failed closed: ${hit}`);
  }
}

function assertFreshPlan(expiresAt: string, label: string): void {
  if (new Date(expiresAt).getTime() <= Date.now() + 2_000) {
    throw new Error(`Canix ${label} is expired or too close to expiry`);
  }
}

function normalizeStepKind(
  kind: string,
): CompiledPlanKind | "eligibility" | undefined {
  const normalized = kind.toLowerCase().replace(/[_-]/g, "");
  if (normalized === "eligibility") {
    return "eligibility";
  }
  if (normalized === "optin" || normalized === "opt") {
    return "optin";
  }
  if (
    normalized === "swap" ||
    normalized === "haystack" ||
    normalized === "haystackswap" ||
    normalized === "swapleg"
  ) {
    return "swap";
  }
  if (normalized === "setup" || normalized === "prerequisite") {
    return "setup";
  }
  if (
    normalized === "enter" ||
    normalized === "deposit" ||
    normalized === "stake"
  ) {
    return "enter";
  }
  return undefined;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}
