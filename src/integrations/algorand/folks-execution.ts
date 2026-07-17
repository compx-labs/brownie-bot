import type { OpportunityExecutionShape } from "../../domain.js";

export type FolksShapeRole = "setup" | "opt" | "deposit" | "other";

export function classifyFolksShape(
  shape: OpportunityExecutionShape,
): FolksShapeRole {
  const key = shape.shapeKey.toLowerCase();
  const action = shape.action.toLowerCase();
  const variant = shape.variant.toLowerCase();
  if (
    key.includes("depositescrow") ||
    (action === "setup" && variant.includes("depositescrow")) ||
    (action === "setup" && !key.includes("opt") && !variant.includes("opt"))
  ) {
    return "setup";
  }
  if (
    key.includes("optescrow") ||
    variant.includes("optescrow") ||
    (action === "setup" && (key.includes("opt") || variant.includes("opt"))) ||
    action === "optin"
  ) {
    return "opt";
  }
  if (action === "deposit" || key.includes(":deposit:")) {
    return "deposit";
  }
  return "other";
}

/** True when shapes need host-side escrow gating (not a single batched quote). */
export function needsSequentialEscrowExecution(
  shapes: OpportunityExecutionShape[],
): boolean {
  if (shapes.length <= 1) {
    return false;
  }
  return shapes.some((shape) => {
    const role = classifyFolksShape(shape);
    return (
      role === "setup" ||
      role === "opt" ||
      shape.requiredInputs.includes("escrowAddress")
    );
  });
}

export function sortExecutionShapes(
  shapes: OpportunityExecutionShape[],
): OpportunityExecutionShape[] {
  return [...shapes].sort(
    (left, right) =>
      left.order - right.order || left.shapeKey.localeCompare(right.shapeKey),
  );
}

/**
 * Choose which advertised shapes to run given persisted escrow + on-chain opt-in.
 * MCP always lists setup/opt/deposit; brownie skips completed prerequisites.
 */
export function selectEscrowShapesToRun(
  shapes: OpportunityExecutionShape[],
  options: {
    hasEscrow: boolean;
    escrowOptedIntoAsset: boolean;
  },
): OpportunityExecutionShape[] {
  const sorted = sortExecutionShapes(shapes);
  if (!options.hasEscrow) {
    return sorted;
  }
  return sorted.filter((shape) => {
    const role = classifyFolksShape(shape);
    if (role === "setup") {
      return false;
    }
    if (role === "opt") {
      return !options.escrowOptedIntoAsset;
    }
    return true;
  });
}

export function resolvePoolAppId(
  shapes: OpportunityExecutionShape[],
  executionInput: Record<string, unknown>,
): number | undefined {
  const fromInput = executionInput.poolAppId;
  if (typeof fromInput === "number" && Number.isInteger(fromInput) && fromInput > 0) {
    return fromInput;
  }
  for (const shape of sortExecutionShapes(shapes)) {
    const hint = shape.inputHints?.poolAppId;
    if (typeof hint === "number" && hint > 0) {
      return hint;
    }
  }
  return undefined;
}

export function resolveDepositAssetId(
  shapes: OpportunityExecutionShape[],
  executionInput: Record<string, unknown>,
  fromAssetId: number | null,
): number | undefined {
  if (typeof executionInput.assetId === "number") {
    return executionInput.assetId;
  }
  if (fromAssetId !== null) {
    return fromAssetId;
  }
  for (const shape of sortExecutionShapes(shapes)) {
    const hint = shape.inputHints?.assetId;
    if (typeof hint === "number") {
      return hint;
    }
    if (shape.requiredAssetIds[0] !== undefined) {
      return shape.requiredAssetIds[0];
    }
  }
  return undefined;
}
