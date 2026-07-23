import type {
  Opportunity,
  OpportunityExecutionShape,
  PortfolioAction,
  PortfolioSnapshot,
  Position,
} from "../domain.js";

export const ALGO_ASSET_ID = 0;
export const USDC_ASSET_ID = 31_566_704;

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
 * Resolve the Canix execution shape for an action. Exit shapes are often only
 * present as position.compatibleExitShapeKeys; synthesize from enter hints.
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
  const existing = opportunity?.executionShapes.find(
    (shape) => shape.shapeKey === shapeKey,
  );
  const borrowedHints = borrowInputHints(opportunity);
  if (existing) {
    return {
      ...existing,
      inputHints: {
        ...(borrowedHints ?? {}),
        ...(existing.inputHints ?? {}),
      },
    };
  }

  if (!["close", "reduce"].includes(action.type)) {
    return undefined;
  }

  const segments = shapeKey.split(":");
  return {
    shapeKey,
    protocol: action.protocol ?? opportunity?.protocol ?? "unknown",
    protocolVersion: segments[2] ?? "v1",
    action: segments[3] ?? action.type,
    variant: segments[4] ?? "default",
    title: shapeKey,
    summary: `Exit via ${shapeKey}`,
    order: 99,
    requiredInputs: inferExitRequiredInputs(shapeKey),
    requiredAssetIds: opportunity?.assetIds ?? [],
    inputHints: borrowedHints,
  };
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
  const input: Record<string, unknown> = {
    ...(shape.inputHints ?? {}),
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

  for (const key of shape.requiredInputs) {
    if (key === "userAddress") {
      continue;
    }
    if (input[key] !== undefined) {
      continue;
    }
    const lower = key.toLowerCase();
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
  if (!action.executionShapeKey) {
    return action;
  }
  const shape = resolveShapeForAction(action, opportunities, snapshot);
  if (!shape) {
    return action;
  }
  const opportunity = findOpportunityForAction(
    action,
    opportunities,
    snapshot,
  );
  const position = findPositionForAction(action, snapshot);
  const executionInput = completeExecutionInput({
    action,
    shape,
    opportunity,
    position,
  });
  const previous = action.executionInput ?? {};
  const unchanged =
    action.executionInput !== null &&
    Object.keys(executionInput).length === Object.keys(previous).length &&
    Object.entries(executionInput).every(
      ([key, value]) => previous[key] === value,
    );
  if (unchanged) {
    return action;
  }
  return {
    ...action,
    amountRaw:
      action.amountRaw ??
      position?.amountRaw ??
      (typeof executionInput.amount === "string"
        ? executionInput.amount
        : null),
    fromAssetId: action.fromAssetId ?? position?.assetId ?? null,
    opportunityId:
      action.opportunityId ?? position?.opportunityId ?? null,
    executionInput,
  };
}
