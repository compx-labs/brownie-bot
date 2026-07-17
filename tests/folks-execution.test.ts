import { describe, expect, it } from "vitest";

import {
  buildShapeInput,
} from "../src/integrations/algorand/execution.js";
import {
  classifyFolksShape,
  needsSequentialEscrowExecution,
  selectEscrowShapesToRun,
} from "../src/integrations/algorand/folks-execution.js";
import { enterShape } from "./fixtures.js";

describe("Folks escrow step selection", () => {
  const shapes = [
    enterShape({
      shapeKey: "mainnet:folks-finance:v2:setup:depositEscrow",
      protocol: "folks-finance",
      action: "setup",
      variant: "depositEscrow",
      order: 0,
      requiredInputs: ["userAddress"],
      requiredAssetIds: [],
      inputHints: { poolAppId: 971_372_237, assetId: 31_566_704 },
    }),
    enterShape({
      shapeKey: "mainnet:folks-finance:v2:setup:optEscrowAsset",
      protocol: "folks-finance",
      action: "setup",
      variant: "optEscrowAsset",
      order: 1,
      requiredInputs: ["userAddress", "escrowAddress"],
      requiredAssetIds: [31_566_704],
      inputHints: { poolAppId: 971_372_237, assetId: 31_566_704 },
    }),
    enterShape({
      shapeKey: "mainnet:folks-finance:v2:deposit:escrow",
      protocol: "folks-finance",
      action: "deposit",
      variant: "escrow",
      order: 2,
      requiredInputs: ["userAddress", "assetAmount"],
      requiredAssetIds: [31_566_704],
      inputHints: { poolAppId: 971_372_237, assetId: 31_566_704 },
    }),
  ];

  it("detects Folks multi-step escrow flows as sequential", () => {
    expect(needsSequentialEscrowExecution(shapes)).toBe(true);
    expect(classifyFolksShape(shapes[0]!)).toBe("setup");
    expect(classifyFolksShape(shapes[1]!)).toBe("opt");
    expect(classifyFolksShape(shapes[2]!)).toBe("deposit");
  });

  it("runs all shapes when escrow is missing", () => {
    expect(
      selectEscrowShapesToRun(shapes, {
        hasEscrow: false,
        escrowOptedIntoAsset: false,
      }).map((shape) => shape.shapeKey),
    ).toEqual([
      "mainnet:folks-finance:v2:setup:depositEscrow",
      "mainnet:folks-finance:v2:setup:optEscrowAsset",
      "mainnet:folks-finance:v2:deposit:escrow",
    ]);
  });

  it("skips setup when escrow exists but still needs asset opt-in", () => {
    expect(
      selectEscrowShapesToRun(shapes, {
        hasEscrow: true,
        escrowOptedIntoAsset: false,
      }).map((shape) => shape.shapeKey),
    ).toEqual([
      "mainnet:folks-finance:v2:setup:optEscrowAsset",
      "mainnet:folks-finance:v2:deposit:escrow",
    ]);
  });

  it("runs deposit only when escrow exists and is opted in", () => {
    expect(
      selectEscrowShapesToRun(shapes, {
        hasEscrow: true,
        escrowOptedIntoAsset: true,
      }).map((shape) => shape.shapeKey),
    ).toEqual(["mainnet:folks-finance:v2:deposit:escrow"]);
  });

  it("prefers poolAppId over assetId for all Folks steps", () => {
    const executionInput = {
      assetAmount: "30000000",
      escrowAddress: "ESCROW",
    };
    for (const shape of shapes) {
      const input = buildShapeInput(shape, executionInput, 100);
      expect(input.poolAppId).toBe(971_372_237);
      expect(input.assetId).toBeUndefined();
    }
    expect(
      buildShapeInput(shapes[2]!, executionInput, 100),
    ).toMatchObject({
      poolAppId: 971_372_237,
      assetAmount: "30000000",
    });
  });
});
