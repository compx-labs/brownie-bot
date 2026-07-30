import type {
  Opportunity,
  OpportunityExecutionShape,
  PortfolioAction,
  PortfolioSnapshot,
  Position,
} from "../domain.js";

export const ALGO_ASSET_ID = 0;
export const USDC_ASSET_ID = 31_566_704;

export const TINYMAN_FARM_CLAIM_SHAPE =
  "mainnet:tinyman:staking-v1:farm:claimRewards";

/**
 * Infer requiredInputs when Canix only lists an exit shapeKey on the position
 * (common for Tinyman LP — enter shapes live on the opportunity, remove on the position).
 */
export function inferExitRequiredInputs(exitShapeKey: string): string[] {
  const key = exitShapeKey.toLowerCase();
  if (key.includes("removeliquidity")) {
    if (key.includes("singleasset")) {
      return [
        "assetAId",
        "assetBId",
        "poolTokenAmount",
        "outputAssetId",
        "maxSlippageBps",
      ];
    }
    return ["assetAId", "assetBId", "poolTokenAmount", "maxSlippageBps"];
  }
  if (key.includes("folks") && key.includes("withdraw")) {
    return ["amount", "amountDenomination", "poolAppId", "escrowAddress"];
  }
  if (key.includes("reti") && key.includes("unstake")) {
    return ["validatorId", "poolAppId", "amount"];
  }
  if (key.includes("myth") && key.includes("redeem")) {
    return ["amount", "appId"];
  }
  if (key.includes("unstake")) {
    return ["amount", "assetId"];
  }
  return ["amount"];
}

/** Infer requiredInputs for manage/claim shapes listed only on the position. */
export function inferClaimRequiredInputs(claimShapeKey: string): string[] {
  const key = claimShapeKey.toLowerCase();
  if (
    key.includes("claimrewards") ||
    (key.includes("farm") && key.includes("claim"))
  ) {
    return ["userAddress", "programId", "poolAddress"];
  }
  if (key.includes("claim")) {
    return ["userAddress"];
  }
  return ["amount"];
}

/**
 * Infer requiredInputs when topping up an existing position and the enter shape
 * is not in the researched opportunity catalog (common for Réti validators).
 */
export function inferEnterRequiredInputs(enterShapeKey: string): string[] {
  const key = enterShapeKey.toLowerCase();
  if (key.includes("reti") && key.includes("stake")) {
    return ["userAddress", "validatorId", "amount"];
  }
  if (key.includes("folks") && (key.includes("deposit") || key.includes("supply"))) {
    return ["amount", "amountDenomination", "poolAppId"];
  }
  if (key.includes("myth") && (key.includes("stake") || key.includes("mint"))) {
    return ["amount", "appId"];
  }
  if (key.includes("addliquidity")) {
    if (key.includes("singleasset")) {
      return [
        "depositAssetId",
        "depositAmount",
        "assetAId",
        "assetBId",
        "maxSlippageBps",
      ];
    }
    return [
      "assetAId",
      "assetBId",
      "assetAAmount",
      "assetBAmount",
      "maxSlippageBps",
    ];
  }
  if (key.includes("deposit") || key.includes("stake") || key.includes("supply")) {
    return ["amount", "assetId"];
  }
  return ["amount"];
}

/**
 * Parse Tinyman farm reward position identity into claim inputs.
 * positionId: tinyman:reward:{poolAddress}:{programId}:{rewardAssetId}
 * notes (optional): Farm programId=…; poolAddress=…
 */
export function parseTinymanRewardPositionHints(
  position: Position | undefined,
): Record<string, unknown> {
  if (!position) {
    return {};
  }
  const fromNotes = parseTinymanFarmNotes(position.notes);
  const fromId = parseTinymanRewardPositionId(position.positionId);
  // positionId wins over notes when both present.
  return { ...fromNotes, ...fromId };
}

export function parseTinymanRewardPositionId(
  positionId: string,
): Record<string, unknown> {
  const parts = positionId.split(":");
  if (parts.length < 5 || parts[0] !== "tinyman" || parts[1] !== "reward") {
    return {};
  }
  const poolAddress = parts[2];
  const programIdRaw = parts[3];
  if (!poolAddress || !programIdRaw) {
    return {};
  }
  const programIdNumber = Number(programIdRaw);
  const programId = Number.isFinite(programIdNumber)
    ? programIdNumber
    : programIdRaw;
  return {
    poolAddress,
    poolId: poolAddress,
    programId,
  };
}

export function parseTinymanFarmNotes(
  notes: string | undefined,
): Record<string, unknown> {
  if (!notes) {
    return {};
  }
  const hints: Record<string, unknown> = {};
  const programMatch = notes.match(/programId\s*=\s*(\d+)/i);
  if (programMatch?.[1]) {
    hints.programId = Number(programMatch[1]);
  }
  const poolMatch = notes.match(/poolAddress\s*=\s*([A-Z2-7]+)/i);
  if (poolMatch?.[1]) {
    hints.poolAddress = poolMatch[1];
    hints.poolId = poolMatch[1];
  }
  return hints;
}

/** First ASA gate asset id from Réti-style entryRequirements, if any. */
export function firstAsaGateAssetId(
  opportunity: Opportunity | undefined,
): number | undefined {
  const gates = opportunity?.entryRequirements?.gates;
  if (!gates) {
    return undefined;
  }
  for (const gate of gates) {
    if (gate.kind !== "asa") {
      continue;
    }
    const assetId = (gate as { assetId?: unknown }).assetId;
    if (typeof assetId === "number" && Number.isInteger(assetId) && assetId >= 0) {
      return assetId;
    }
  }
  return undefined;
}

function borrowInputHints(
  opportunity: Opportunity | undefined,
): OpportunityExecutionShape["inputHints"] {
  if (!opportunity) {
    return undefined;
  }
  for (const shape of opportunity.executionShapes) {
    if (shape.inputHints && Object.keys(shape.inputHints).length > 0) {
      return { ...shape.inputHints };
    }
  }
  return undefined;
}

export function findOpportunityForAction(
  action: PortfolioAction,
  opportunities: Opportunity[],
  snapshot?: PortfolioSnapshot,
): Opportunity | undefined {
  if (action.opportunityId) {
    const direct = opportunities.find(
      (candidate) => candidate.opportunityId === action.opportunityId,
    );
    if (direct) {
      return direct;
    }
  }
  if (!action.positionId || !snapshot) {
    return undefined;
  }
  const position = snapshot.positions.find(
    (candidate) => candidate.positionId === action.positionId,
  );
  if (!position?.opportunityId) {
    return undefined;
  }
  return opportunities.find(
    (candidate) => candidate.opportunityId === position.opportunityId,
  );
}

export function findPositionForAction(
  action: PortfolioAction,
  snapshot?: PortfolioSnapshot,
): Position | undefined {
  if (!action.positionId || !snapshot) {
    return undefined;
  }
  return snapshot.positions.find(
    (candidate) => candidate.positionId === action.positionId,
  );
}

/**
 * Resolve the Canix execution shape for an action. Exit/manage shapes are often
 * only present as position compatibleExit/ManageShapeKeys; synthesize required
 * inputs (and Tinyman claim hints) when the opportunity catalog lacks the shape.
 */
export function resolveShapeForAction(
  action: PortfolioAction,
  opportunities: Opportunity[],
  snapshot?: PortfolioSnapshot,
): OpportunityExecutionShape | undefined {
  const shapeKey = action.executionShapeKey;
  if (!shapeKey) {
    return undefined;
  }
  const opportunity = findOpportunityForAction(
    action,
    opportunities,
    snapshot,
  );
  const position = findPositionForAction(action, snapshot);
  const borrowedHints = borrowInputHints(opportunity);
  const rewardHints = parseTinymanRewardPositionHints(position);
  const existing = opportunity?.executionShapes.find(
    (shape) => shape.shapeKey === shapeKey,
  );
  if (existing) {
    return {
      ...existing,
      inputHints: {
        ...(borrowedHints ?? {}),
        ...(position?.inputHints ?? {}),
        ...rewardHints,
        ...(existing.inputHints ?? {}),
      },
    };
  }

  const segments = shapeKey.split(":");
  if (["close", "reduce", "claim"].includes(action.type)) {
    const isClaim = action.type === "claim";
    return {
      shapeKey,
      protocol: action.protocol ?? opportunity?.protocol ?? "unknown",
      protocolVersion: segments[2] ?? "v1",
      action: segments[3] ?? action.type,
      variant: segments[4] ?? "default",
      title: shapeKey,
      summary: isClaim ? `Claim via ${shapeKey}` : `Exit via ${shapeKey}`,
      order: 99,
      requiredInputs: isClaim
        ? inferClaimRequiredInputs(shapeKey)
        : inferExitRequiredInputs(shapeKey),
      requiredAssetIds: opportunity?.assetIds ?? [],
      inputHints: {
        ...(borrowedHints ?? {}),
        ...(position?.inputHints ?? {}),
        ...rewardHints,
      },
    };
  }

  // increase/open: synthesize enter shape from position hints when the researched
  // catalog missed this opportunity (e.g. Réti validator not in top-N list).
  if (
    ["open", "increase"].includes(action.type) &&
    position &&
    (position.inputHints || action.type === "increase")
  ) {
    return {
      shapeKey,
      protocol:
        action.protocol ?? opportunity?.protocol ?? position.protocol ?? "unknown",
      protocolVersion: segments[2] ?? "v1",
      action: segments[3] ?? action.type,
      variant: segments[4] ?? "default",
      title: shapeKey,
      summary: `Enter via ${shapeKey}`,
      order: 99,
      requiredInputs: inferEnterRequiredInputs(shapeKey),
      requiredAssetIds:
        opportunity?.assetIds ??
        (position.assetId !== null ? [position.assetId] : []),
      inputHints: {
        ...(borrowedHints ?? {}),
        ...(position.inputHints ?? {}),
      },
    };
  }

  return undefined;
}

function amountsByAssetFromAction(
  action: PortfolioAction,
  position: Position | undefined,
): Map<number, string> {
  const amounts = new Map<number, string>();
  for (const spend of action.authorizedSpends) {
    amounts.set(spend.assetId, spend.amountRaw);
  }
  const exitAmount =
    action.amountRaw ?? position?.amountRaw ?? undefined;
  const assetId = action.fromAssetId ?? position?.assetId ?? null;
  if (exitAmount && assetId !== null && !amounts.has(assetId)) {
    amounts.set(assetId, exitAmount);
  }
  return amounts;
}

/**
 * Fill missing Canix shape requiredInputs from inputHints, authorizedSpends,
 * action/position amounts, and opportunity asset pair metadata.
 * Explicit action.executionInput values always win.
 */
export function completeExecutionInput(options: {
  action: PortfolioAction;
  shape: OpportunityExecutionShape;
  opportunity?: Opportunity;
  position?: Position;
}): Record<string, unknown> {
  const { action, shape, opportunity, position } = options;
  const rewardHints = parseTinymanRewardPositionHints(position);
  const input: Record<string, unknown> = {
    ...(shape.inputHints ?? {}),
    ...rewardHints,
    ...(action.executionInput ?? {}),
  };
  const amountsByAsset = amountsByAssetFromAction(action, position);
  const exitAmountRaw =
    action.amountRaw ?? position?.amountRaw ?? undefined;
  const algoAmount = amountsByAsset.get(ALGO_ASSET_ID);
  const usdcAmount = amountsByAsset.get(USDC_ASSET_ID);
  const primaryAmount =
    exitAmountRaw ??
    usdcAmount ??
    algoAmount ??
    [...amountsByAsset.values()][0];
  const pairIds = opportunity?.assetIds ?? [];

  const positionHints = position?.inputHints ?? {};
  for (const [hintKey, hintValue] of Object.entries(positionHints)) {
    if (input[hintKey] === undefined && hintValue !== undefined) {
      input[hintKey] = hintValue;
    }
  }

  // Canix accepts poolId as an alias for poolAddress on Tinyman farm claim.
  if (input.poolAddress === undefined && input.poolId !== undefined) {
    input.poolAddress = input.poolId;
  }
  if (input.poolId === undefined && input.poolAddress !== undefined) {
    input.poolId = input.poolAddress;
  }

  for (const key of shape.requiredInputs) {
    if (key === "userAddress") {
      continue;
    }
    const lower = key.toLowerCase();
    if (!isMissingInputValue(input[key])) {
      const coercedAssetId = coerceNonNegativeIntAssetId(key, input[key]);
      if (coercedAssetId !== undefined) {
        input[key] = coercedAssetId;
      }
      continue;
    }
    if (lower === "assetaid" || lower === "asseta_id") {
      input[key] =
        pairIds.find((assetId) => assetId !== ALGO_ASSET_ID) ??
        pairIds[0] ??
        USDC_ASSET_ID;
      continue;
    }
    if (lower === "assetbid" || lower === "assetb_id") {
      input[key] =
        pairIds.find((assetId) => assetId === ALGO_ASSET_ID) ??
        pairIds[1] ??
        ALGO_ASSET_ID;
      continue;
    }
    if (lower === "depositassetid" || lower === "deposit_asset_id") {
      const depositAssetId = resolveDepositAssetId({
        action,
        input,
        amountsByAsset,
      });
      if (depositAssetId !== undefined) {
        input[key] = depositAssetId;
      }
      continue;
    }
    if (lower === "outputassetid" || lower === "output_asset_id") {
      const outputAssetId = resolveOutputAssetId({
        action,
        input,
        pairIds,
      });
      if (outputAssetId !== undefined) {
        input[key] = outputAssetId;
      }
      continue;
    }
    if (lower.includes("asseta") && lower.includes("amount")) {
      const assetAId = input.assetAId;
      if (typeof assetAId === "number" && amountsByAsset.has(assetAId)) {
        input[key] = amountsByAsset.get(assetAId);
        continue;
      }
    }
    if (lower.includes("assetb") && lower.includes("amount")) {
      const assetBId = input.assetBId;
      if (typeof assetBId === "number" && amountsByAsset.has(assetBId)) {
        input[key] = amountsByAsset.get(assetBId);
        continue;
      }
    }
    if (lower === "assetid" && action.fromAssetId !== null) {
      input[key] = action.fromAssetId;
      continue;
    }
    if (lower === "assetid" && position?.assetId !== null && position) {
      input[key] = position.assetId;
      continue;
    }
    if (lower === "appid") {
      const fromPool =
        typeof input.poolAppId === "number" ? input.poolAppId : undefined;
      if (fromPool !== undefined) {
        input[key] = fromPool;
        continue;
      }
    }
    if (lower === "pooladdress" && input.poolId !== undefined) {
      input[key] = input.poolId;
      continue;
    }
    if (lower === "poolid" && input.poolAddress !== undefined) {
      input[key] = input.poolAddress;
      continue;
    }
    if (lower === "valuetoverify") {
      const gateAsa = firstAsaGateAssetId(opportunity);
      if (gateAsa !== undefined) {
        input[key] = gateAsa;
        continue;
      }
    }
    if (lower === "amountdenomination" && isFolksWithdrawShape(shape.shapeKey)) {
      input[key] = "asset";
      continue;
    }
    if (lower === "depositamount") {
      const depositAssetId =
        typeof input.depositAssetId === "number"
          ? input.depositAssetId
          : resolveDepositAssetId({ action, input, amountsByAsset });
      if (
        depositAssetId !== undefined &&
        amountsByAsset.has(depositAssetId)
      ) {
        input[key] = amountsByAsset.get(depositAssetId);
        continue;
      }
    }
    if (/amount/i.test(key) && primaryAmount) {
      input[key] = primaryAmount;
    }
  }

  // Réti / Myth: optional gate field may not be listed in requiredInputs.
  if (
    input.valueToVerify === undefined &&
    /reti/i.test(shape.shapeKey) &&
    /stake/i.test(shape.shapeKey) &&
    !/unstake/i.test(shape.shapeKey)
  ) {
    const gateAsa = firstAsaGateAssetId(opportunity);
    if (gateAsa !== undefined) {
      input.valueToVerify = gateAsa;
    }
  }

  return sanitizeCompletedInput(shape.shapeKey, input);
}

function isFolksWithdrawShape(shapeKey: string): boolean {
  return /folks/i.test(shapeKey) && /withdraw/i.test(shapeKey);
}

function isMissingInputValue(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function coerceNonNegativeIntAssetId(
  key: string,
  value: unknown,
): number | undefined {
  if (!/assetid$/i.test(key) && !/asset_id$/i.test(key)) {
    return undefined;
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return undefined; // already valid
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return undefined;
}

function resolveDepositAssetId(options: {
  action: PortfolioAction;
  input: Record<string, unknown>;
  amountsByAsset: Map<number, string>;
}): number | undefined {
  const { action, input, amountsByAsset } = options;
  if (action.fromAssetId !== null) {
    return action.fromAssetId;
  }
  if (action.authorizedSpends.length === 1) {
    return action.authorizedSpends[0]!.assetId;
  }
  if (typeof input.assetId === "number" && Number.isInteger(input.assetId)) {
    return input.assetId;
  }
  if (typeof input.assetId === "string" && /^\d+$/.test(input.assetId)) {
    const parsed = Number(input.assetId);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  if (amountsByAsset.size === 1) {
    return [...amountsByAsset.keys()][0];
  }
  if (amountsByAsset.has(USDC_ASSET_ID)) {
    return USDC_ASSET_ID;
  }
  if (amountsByAsset.has(ALGO_ASSET_ID)) {
    return ALGO_ASSET_ID;
  }
  return undefined;
}

/**
 * Single-asset LP exit: which pool leg to receive.
 * Prefer explicit toAssetId, then USDC when in-pair (treasury ops), else non-ALGO.
 */
function resolveOutputAssetId(options: {
  action: PortfolioAction;
  input: Record<string, unknown>;
  pairIds: number[];
}): number | undefined {
  const { action, input, pairIds } = options;
  if (action.toAssetId !== null) {
    return action.toAssetId;
  }
  const poolAssets = [
    typeof input.assetAId === "number" ? input.assetAId : undefined,
    typeof input.assetBId === "number" ? input.assetBId : undefined,
    ...pairIds,
  ].filter((assetId): assetId is number => typeof assetId === "number");
  if (poolAssets.includes(USDC_ASSET_ID)) {
    return USDC_ASSET_ID;
  }
  const nonAlgo = poolAssets.find((assetId) => assetId !== ALGO_ASSET_ID);
  if (nonAlgo !== undefined) {
    return nonAlgo;
  }
  if (poolAssets.includes(ALGO_ASSET_ID)) {
    return ALGO_ASSET_ID;
  }
  return undefined;
}

function sanitizeCompletedInput(
  shapeKey: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...input };
  if (isFolksWithdrawShape(shapeKey)) {
    if (next.amountDenomination === undefined) {
      next.amountDenomination = "asset";
    }
    delete next.assetAmount;
    delete next.liquidityAssetAmount;
    delete next.poolTokenAmount;
    // Canix withdraw rejects poolAppId + assetId together; prefer poolAppId.
    if (next.poolAppId !== undefined) {
      delete next.assetId;
    }
  }
  return next;
}

/**
 * Host-side completion used by production (portfolio agent) and protocol-verify.
 * Agent may emit partial/null executionInput; required shape fields are filled here.
 */
export function completeActionExecutionInput(
  action: PortfolioAction,
  opportunities: Opportunity[],
  snapshot?: PortfolioSnapshot,
): PortfolioAction {
  const position = findPositionForAction(action, snapshot);
  const opportunityId =
    action.opportunityId ?? position?.opportunityId ?? null;
  const withOpportunity =
    opportunityId !== action.opportunityId
      ? { ...action, opportunityId }
      : action;

  if (!withOpportunity.executionShapeKey) {
    return withOpportunity;
  }
  const shape = resolveShapeForAction(
    withOpportunity,
    opportunities,
    snapshot,
  );
  if (!shape) {
    return withOpportunity;
  }
  const opportunity = findOpportunityForAction(
    withOpportunity,
    opportunities,
    snapshot,
  );
  const executionInput = completeExecutionInput({
    action: withOpportunity,
    shape,
    opportunity,
    position,
  });
  const previous = withOpportunity.executionInput ?? {};
  const unchanged =
    withOpportunity.executionInput !== null &&
    withOpportunity.opportunityId === opportunityId &&
    Object.keys(executionInput).length === Object.keys(previous).length &&
    Object.entries(executionInput).every(
      ([key, value]) => previous[key] === value,
    );
  if (unchanged) {
    return withOpportunity;
  }
  let amountRaw = withOpportunity.amountRaw;
  if (
    amountRaw === null &&
    ["close", "reduce", "claim"].includes(withOpportunity.type)
  ) {
    amountRaw = position?.amountRaw ?? null;
  }
  if (amountRaw === null && typeof executionInput.amount === "string") {
    amountRaw = executionInput.amount;
  }
  return {
    ...withOpportunity,
    amountRaw,
    fromAssetId: withOpportunity.fromAssetId ?? position?.assetId ?? null,
    opportunityId,
    executionInput,
  };
}
