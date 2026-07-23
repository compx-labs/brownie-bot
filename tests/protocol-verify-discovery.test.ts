import algosdk from "algosdk";
import { describe, expect, it, vi } from "vitest";

import { loadProtocolVerifyConfig } from "../src/cli/config.js";
import type { Opportunity } from "../src/domain.js";
import { normalizePortfolioPlan } from "../src/services/portfolio-policy.js";
import {
  ALGO_ASSET_ID,
  DEFAULT_PROTOCOL_VERIFY_FIXTURE_PATH,
  MYTH_MINT_SHAPE,
  MYTH_REDEEM_SHAPE,
  ORA_ASSET_ID,
  RETI_STAKE_SHAPE,
  RETI_UNSTAKE_SHAPE,
  RETI_VERIFY_OPPORTUNITY_ID,
  USDC_ASSET_ID,
  assertAllCasesPinned,
  buildExitAction,
  loadProtocolVerifyFixture,
  matchProtocolVerifyCases,
  pickCapitalEnterShape,
  refreshPinnedOpportunity,
  resolveLstReceiptAssetId,
  toBaseUnits,
} from "../src/services/protocol-verify.js";
import {
  completeExecutionInput,
  firstAsaGateAssetId,
  inferExitRequiredInputs,
} from "../src/services/shape-execution-input.js";
import {
  enterShape,
  opportunity,
  portfolioPlan,
  portfolioSnapshot,
  position,
} from "./fixtures.js";

/** Pinned from `npm run canix:discover-verify` (2026-07-23). */
const PINNED_OPPORTUNITY_IDS = {
  "folks-usdc-deposit": "folks-lending-971372237",
  "folks-algo-stake": "folks-staking-xalgo",
  "tinyman-lp":
    "2PIFZW53RHCSFSYMCFUBW4XOCXOMB7XOYQSQ6KGT3KVGJTL4HM6COZRNMM:lp",
  "compx-lending": "compx-lending-3491050310",
  "dorkfi-usdc-lending": "dorkfi:algorand:3333688282:31566704:lending",
  "pact-lp": "3585364727:farm",
  "haystack-swap": null,
  "reti-pooling": "reti-staking-220",
  "myth-dualstake": "myth-staking-2933534328",
} as const;

const PINNED_ENTER_SHAPE_KEYS = {
  "folks-usdc-deposit": "mainnet:folks-finance:v2:deposit:escrow",
  "folks-algo-stake": "mainnet:folks-finance:xalgo-v1:stake:immediate",
  "tinyman-lp": "mainnet:tinyman:v2:addLiquidity:flexible",
  "compx-lending": "mainnet:compx:v1:deposit:asa",
  "dorkfi-usdc-lending": "mainnet:dorkfi:v1:deposit:asa",
  "pact-lp": "mainnet:pact:v1:addLiquidityAndFarm:twoSided",
  "haystack-swap": null,
  "reti-pooling": "mainnet:reti:v1:stake:algo",
  "myth-dualstake": "mainnet:myth-finance:dualstake-v1:mint:lst",
} as const;

function folksDepositOpportunity(): Opportunity {
  return opportunity({
    protocol: "folks-finance",
    opportunityType: "lending",
    opportunityId: "folks:usdc:verify",
    assetPair: "USDC",
    assetIds: [USDC_ASSET_ID],
    executionShapes: [
      enterShape({
        shapeKey: "mainnet:folks-finance:v2:setup:depositEscrow",
        protocol: "folks-finance",
        action: "setup",
        variant: "depositEscrow",
        title: "Setup",
        summary: "Setup escrow",
        order: 0,
        requiredInputs: [],
        requiredAssetIds: [],
        inputHints: { poolAppId: 1 },
      }),
      enterShape({
        shapeKey: "mainnet:folks-finance:v2:deposit:escrow",
        protocol: "folks-finance",
        action: "deposit",
        variant: "escrow",
        title: "Deposit",
        summary: "Deposit USDC",
        order: 2,
        requiredInputs: ["assetAmount"],
        requiredAssetIds: [USDC_ASSET_ID],
        inputHints: { assetId: USDC_ASSET_ID, poolAppId: 1 },
      }),
      enterShape({
        shapeKey: "mainnet:folks-finance:v2:withdraw:escrow",
        protocol: "folks-finance",
        action: "withdraw",
        variant: "escrow",
        title: "Withdraw",
        summary: "Withdraw USDC",
        order: 3,
        requiredInputs: ["assetAmount"],
        requiredAssetIds: [USDC_ASSET_ID],
        inputHints: { assetId: USDC_ASSET_ID, poolAppId: 1 },
      }),
    ],
  });
}

function folksStakeOpportunity(): Opportunity {
  return opportunity({
    protocol: "folks-finance",
    opportunityType: "staking",
    opportunityId: "folks:algo:stake",
    assetPair: "ALGO/xALGO",
    assetIds: [ALGO_ASSET_ID, 1_134_696_561],
    executionShapes: [
      enterShape({
        shapeKey: "mainnet:folks-finance:xalgo-v1:stake:immediate",
        protocol: "folks-finance",
        action: "stake",
        variant: "immediate",
        title: "Stake",
        summary: "Stake ALGO",
        order: 0,
        requiredInputs: ["assetAmount"],
        requiredAssetIds: [ALGO_ASSET_ID],
        inputHints: { assetId: ALGO_ASSET_ID },
      }),
      enterShape({
        shapeKey: "mainnet:folks-finance:xalgo-v1:unstake:immediate",
        protocol: "folks-finance",
        action: "unstake",
        variant: "immediate",
        title: "Unstake",
        summary: "Unstake xALGO",
        order: 1,
        requiredInputs: ["assetAmount"],
        requiredAssetIds: [1_134_696_561],
        inputHints: { assetId: 1_134_696_561 },
      }),
    ],
  });
}

function tinymanLpOpportunity(): Opportunity {
  return opportunity({
    protocol: "tinyman",
    opportunityType: "lp",
    opportunityId: "tinyman:pool:algo-usdc",
    assetPair: "ALGO/USDC",
    assetIds: [ALGO_ASSET_ID, USDC_ASSET_ID],
    executionShapes: [
      enterShape({
        shapeKey: "mainnet:tinyman:v2:addLiquidity:flexible",
        protocol: "tinyman",
        action: "addLiquidity",
        variant: "flexible",
        order: 0,
        requiredInputs: [
          "assetAId",
          "assetBId",
          "assetAAmount",
          "assetBAmount",
        ],
        requiredAssetIds: [ALGO_ASSET_ID, USDC_ASSET_ID],
        inputHints: { assetAId: ALGO_ASSET_ID, assetBId: USDC_ASSET_ID },
      }),
      enterShape({
        shapeKey: "mainnet:tinyman:v2:removeLiquidity:flexible",
        protocol: "tinyman",
        action: "removeLiquidity",
        variant: "flexible",
        order: 1,
        requiredInputs: ["liquidityAssetAmount"],
        requiredAssetIds: [],
      }),
    ],
  });
}

function retiPoolingOpportunity(
  options: { gated?: boolean; opportunityId?: string; validatorId?: number } = {},
): Opportunity {
  const gated = options.gated ?? true;
  const validatorId =
    options.validatorId ??
    (options.opportunityId === RETI_VERIFY_OPPORTUNITY_ID
      ? 220
      : gated
        ? 12
        : 3);
  const opportunityId =
    options.opportunityId ??
    (gated ? "reti-staking-12" : "reti-staking-3");
  return opportunity({
    protocol: "reti",
    opportunityType: "staking",
    opportunityId,
    assetPair: "ALGO",
    assetIds: [ALGO_ASSET_ID],
    entryRequirements: {
      minAmount: { assetId: 0, amount: "1000000" },
      ...(gated
        ? {
            gates: [{ kind: "asa" as const, assetId: 123 }],
            gateMatch: "any" as const,
            eligibilityFullyCheckable: true,
          }
        : { eligibilityFullyCheckable: true }),
    },
    capacity: {
      stakerSlotsRemaining: 10,
      algoRoomMicroAlgos: "5000000000",
      acceptingStake: true,
    },
    executionShapes: [
      enterShape({
        shapeKey: RETI_STAKE_SHAPE,
        protocol: "reti",
        protocolVersion: "v1",
        action: "stake",
        variant: "algo",
        title: "Réti stake",
        summary: "Stake ALGO",
        order: 0,
        requiredInputs: ["userAddress", "validatorId", "amount"],
        requiredAssetIds: [ALGO_ASSET_ID],
        inputHints: {
          validatorId,
          assetId: ALGO_ASSET_ID,
        },
      }),
    ],
  });
}

function mythDualstakeOpportunity(): Opportunity {
  const lstId = 2_933_535_000;
  return opportunity({
    protocol: "myth-finance",
    opportunityType: "staking",
    opportunityId: "myth-staking-2933534328",
    assetPair: "ALGO/ORA→oraALGO",
    assetIds: [ALGO_ASSET_ID, ORA_ASSET_ID, lstId],
    executionShapes: [
      enterShape({
        shapeKey: MYTH_MINT_SHAPE,
        protocol: "myth-finance",
        protocolVersion: "dualstake-v1",
        action: "mint",
        variant: "lst",
        title: "Myth mint",
        summary: "Mint dualSTAKE LST",
        order: 0,
        requiredInputs: ["userAddress", "amount", "appId"],
        requiredAssetIds: [ALGO_ASSET_ID, ORA_ASSET_ID],
        inputHints: {
          poolAppId: 2_933_534_328,
          assetAId: ALGO_ASSET_ID,
          assetBId: ORA_ASSET_ID,
        },
      }),
    ],
  });
}

describe("protocol-verify discovery matching", () => {
  it("pins every required case from a synthetic catalog", () => {
    const catalog = [
      folksDepositOpportunity(),
      folksStakeOpportunity(),
      tinymanLpOpportunity(),
      opportunity({
        protocol: "compx",
        opportunityType: "lending",
        opportunityId: "compx:usdc:1",
        assetPair: "USDC",
        assetIds: [USDC_ASSET_ID],
        executionShapes: [
          enterShape({
            shapeKey: "mainnet:compx:v1:deposit:market",
            protocol: "compx",
            action: "deposit",
            variant: "market",
            requiredInputs: ["assetAmount"],
            requiredAssetIds: [USDC_ASSET_ID],
            inputHints: { assetId: USDC_ASSET_ID },
          }),
          enterShape({
            shapeKey: "mainnet:compx:v1:withdraw:market",
            protocol: "compx",
            action: "withdraw",
            variant: "market",
            requiredInputs: ["assetAmount"],
            requiredAssetIds: [USDC_ASSET_ID],
          }),
        ],
      }),
      opportunity({
        protocol: "dorkfi",
        opportunityType: "lending",
        opportunityId: "dorkfi:usdc:1",
        assetPair: "USDC",
        assetIds: [USDC_ASSET_ID],
        executionShapes: [
          enterShape({
            shapeKey: "mainnet:dorkfi:v1:deposit:usdc",
            protocol: "dorkfi",
            action: "deposit",
            variant: "usdc",
            requiredInputs: ["assetAmount"],
            requiredAssetIds: [USDC_ASSET_ID],
            inputHints: { assetId: USDC_ASSET_ID },
          }),
          enterShape({
            shapeKey: "mainnet:dorkfi:v1:withdraw:usdc",
            protocol: "dorkfi",
            action: "withdraw",
            variant: "usdc",
            requiredInputs: ["assetAmount"],
            requiredAssetIds: [USDC_ASSET_ID],
          }),
        ],
      }),
      opportunity({
        protocol: "pact",
        opportunityType: "lp",
        opportunityId: "pact:pool:algo-usdc",
        assetPair: "ALGO/USDC",
        assetIds: [ALGO_ASSET_ID, USDC_ASSET_ID],
        executionShapes: [
          enterShape({
            shapeKey: "mainnet:pact:v2:addLiquidity:flexible",
            protocol: "pact",
            action: "addLiquidity",
            variant: "flexible",
            requiredInputs: [
              "assetAId",
              "assetBId",
              "assetAAmount",
              "assetBAmount",
            ],
            requiredAssetIds: [ALGO_ASSET_ID, USDC_ASSET_ID],
            inputHints: { assetAId: ALGO_ASSET_ID, assetBId: USDC_ASSET_ID },
          }),
          enterShape({
            shapeKey: "mainnet:pact:v2:removeLiquidity:flexible",
            protocol: "pact",
            action: "removeLiquidity",
            variant: "flexible",
            requiredInputs: ["liquidityAssetAmount"],
            requiredAssetIds: [],
          }),
        ],
      }),
      retiPoolingOpportunity({ gated: true }),
      retiPoolingOpportunity({ gated: false }),
      retiPoolingOpportunity({
        gated: false,
        opportunityId: RETI_VERIFY_OPPORTUNITY_ID,
        validatorId: 220,
      }),
      mythDualstakeOpportunity(),
    ];

    const matched = assertAllCasesPinned(matchProtocolVerifyCases(catalog));
    expect(matched["folks-usdc-deposit"].opportunityId).toBe(
      "folks:usdc:verify",
    );
    expect(matched["folks-usdc-deposit"].exitShapeKey).toBe(
      "mainnet:folks-finance:v2:withdraw:escrow",
    );
    expect(matched["folks-algo-stake"].opportunityId).toBe("folks:algo:stake");
    expect(matched["folks-algo-stake"].receiptAssetId).toBe(1_134_696_561);
    expect(matched["folks-algo-stake"].exitShapeKey).toBe(
      "mainnet:folks-finance:xalgo-v1:unstake:immediate",
    );
    expect(matched["folks-algo-stake"].receiptAssetId).toBe(1_134_696_561);
    expect(matched["tinyman-lp"].opportunityId).toBe("tinyman:pool:algo-usdc");
    expect(matched["compx-lending"].enterShapeKey).toContain("deposit");
    expect(matched["dorkfi-usdc-lending"].protocol).toBe("dorkfi");
    expect(matched["pact-lp"].opportunityId).toBe("pact:pool:algo-usdc");
    expect(matched["haystack-swap"].fromAssetId).toBe(ALGO_ASSET_ID);
    expect(matched["reti-pooling"].opportunityId).toBe(RETI_VERIFY_OPPORTUNITY_ID);
    expect(matched["reti-pooling"].exitShapeKey).toBe(RETI_UNSTAKE_SHAPE);
    expect(matched["reti-pooling"].notes).toMatch(/ungated/);
    expect(matched["myth-dualstake"].opportunityId).toBe(
      "myth-staking-2933534328",
    );
    expect(matched["myth-dualstake"].receiptAssetId).toBe(2_933_535_000);
    expect(matched["myth-dualstake"].exitShapeKey).toBe(MYTH_REDEEM_SHAPE);
  });

  it("prefers Myth LST (assetIds[2]) over paired ORA as receipt", () => {
    const myth = mythDualstakeOpportunity();
    expect(resolveLstReceiptAssetId(myth)).toBe(2_933_535_000);
    expect(resolveLstReceiptAssetId(myth, 99)).toBe(99);
  });

  it("skips prerequisite shapes when picking capital enter", () => {
    const shape = pickCapitalEnterShape(folksDepositOpportunity());
    expect(shape?.shapeKey).toBe("mainnet:folks-finance:v2:deposit:escrow");
  });

  it("converts human amounts to base units", () => {
    expect(toBaseUnits(1, 6)).toBe("1000000");
    expect(toBaseUnits(2.5, 6)).toBe("2500000");
  });
});

describe("shape-execution-input reti/myth", () => {
  it("fills valueToVerify from ASA entryRequirements gates", () => {
    const reti = retiPoolingOpportunity({ gated: true });
    expect(firstAsaGateAssetId(reti)).toBe(123);
    const shape = reti.executionShapes[0]!;
    const input = completeExecutionInput({
      action: {
        id: "open-1",
        type: "open",
        protocol: "reti",
        opportunityId: reti.opportunityId,
        positionId: null,
        amountRaw: "1000000",
        fromAssetId: ALGO_ASSET_ID,
        toAssetId: null,
        targetWeightPct: 10,
        executionShapeKey: shape.shapeKey,
        executionInput: null,
        authorizedSpends: [{ assetId: ALGO_ASSET_ID, amountRaw: "1000000" }],
        rationale: "test",
        dependencies: [],
      },
      shape,
      opportunity: reti,
    });
    expect(input.validatorId).toBe(12);
    expect(input.valueToVerify).toBe(123);
    expect(input.amount).toBe("1000000");
  });

  it("infers Réti unstake and Myth redeem required inputs", () => {
    expect(inferExitRequiredInputs(RETI_UNSTAKE_SHAPE)).toEqual([
      "validatorId",
      "poolAppId",
      "amount",
    ]);
    expect(inferExitRequiredInputs(MYTH_REDEEM_SHAPE)).toEqual([
      "amount",
      "appId",
    ]);
  });

  it("fills Réti unstake fields from position inputHints", () => {
    const reti = retiPoolingOpportunity({ gated: true });
    const held = position({
      protocol: "reti",
      positionType: "staked",
      positionId: "reti:staked:12:99",
      opportunityId: reti.opportunityId,
      assetId: ALGO_ASSET_ID,
      amountRaw: "1000000",
      amount: "1",
      compatibleExitShapeKeys: [RETI_UNSTAKE_SHAPE],
      inputHints: { validatorId: 12, poolAppId: 99, assetId: 0 },
    });
    const exitShape = enterShape({
      shapeKey: RETI_UNSTAKE_SHAPE,
      protocol: "reti",
      protocolVersion: "v1",
      action: "unstake",
      variant: "algo",
      requiredInputs: ["userAddress", "validatorId", "poolAppId", "amount"],
      requiredAssetIds: [ALGO_ASSET_ID],
    });
    const input = completeExecutionInput({
      action: {
        id: "close-1",
        type: "close",
        protocol: "reti",
        opportunityId: reti.opportunityId,
        positionId: held.positionId,
        amountRaw: held.amountRaw,
        fromAssetId: ALGO_ASSET_ID,
        toAssetId: null,
        targetWeightPct: null,
        executionShapeKey: RETI_UNSTAKE_SHAPE,
        executionInput: null,
        authorizedSpends: [],
        rationale: "test",
        dependencies: [],
      },
      shape: exitShape,
      opportunity: reti,
      position: held,
    });
    expect(input.validatorId).toBe(12);
    expect(input.poolAppId).toBe(99);
    expect(input.amount).toBe("1000000");
  });
});

describe("refreshPinnedOpportunity", () => {
  it("fetches only the pinned protocol opportunities", async () => {
    const pinnedOpp = folksDepositOpportunity();
    const callManagedTool = vi.fn().mockResolvedValue({
      data: { data: [pinnedOpp] },
    });
    const canix = { callManagedTool } as never;

    const found = await refreshPinnedOpportunity(
      canix,
      "TESTWALLET",
      {
        caseId: "folks-usdc-deposit",
        opportunityId: pinnedOpp.opportunityId,
        protocol: "folks-finance",
        opportunityType: "lending",
        assetPair: "USDC",
        assetIds: [USDC_ASSET_ID],
        enterShapeKey: "mainnet:folks-finance:v2:deposit:escrow",
        exitShapeKey: "mainnet:folks-finance:v2:withdraw:escrow",
        shapes: [],
      },
    );

    expect(found.opportunityId).toBe(pinnedOpp.opportunityId);
    expect(callManagedTool).toHaveBeenCalledTimes(1);
    expect(callManagedTool).toHaveBeenCalledWith(
      "canix_get_protocol_opportunities",
      {
        protocol: "folks-finance",
        limit: 100,
        offset: 0,
        includeInactive: false,
      },
      "TESTWALLET",
    );
  });
});

describe("protocol-verify pinned fixture", () => {
  it("locks the discovered mainnet opportunity IDs and enter shapes", async () => {
    const fixture = await loadProtocolVerifyFixture(
      DEFAULT_PROTOCOL_VERIFY_FIXTURE_PATH,
    );

    for (const [caseId, opportunityId] of Object.entries(
      PINNED_OPPORTUNITY_IDS,
    )) {
      const pinned = fixture.cases[caseId as keyof typeof PINNED_OPPORTUNITY_IDS];
      expect(pinned, `missing case ${caseId}`).toBeDefined();
      expect(pinned.opportunityId).toBe(opportunityId);
      expect(pinned.enterShapeKey).toBe(
        PINNED_ENTER_SHAPE_KEYS[caseId as keyof typeof PINNED_ENTER_SHAPE_KEYS],
      );
    }

    expect(fixture.cases["haystack-swap"].fromAssetId).toBe(ALGO_ASSET_ID);
    expect(fixture.cases["haystack-swap"].toAssetId).toBe(USDC_ASSET_ID);
    expect(fixture.cases["folks-algo-stake"].receiptAssetId).toBe(1_134_696_561);

    expect(fixture.cases["reti-pooling"].exitShapeKey).toBe(RETI_UNSTAKE_SHAPE);
    expect(fixture.cases["myth-dualstake"].exitShapeKey).toBe(MYTH_REDEEM_SHAPE);
    expect(fixture.cases["myth-dualstake"].assetIds).toContain(ORA_ASSET_ID);
    expect(fixture.cases["myth-dualstake"].receiptAssetId).toBe(2_933_559_000);
  });
});

describe("buildExitAction", () => {
  it("is agent-minimal; host normalize completes Tinyman removeLiquidity fields", () => {
    const candidate = opportunity({
      protocol: "tinyman",
      opportunityId:
        "2PIFZW53RHCSFSYMCFUBW4XOCXOMB7XOYQSQ6KGT3KVGJTL4HM6COZRNMM:lp",
      opportunityType: "lp",
      assetPair: "USDC/ALGO",
      assetIds: [USDC_ASSET_ID, ALGO_ASSET_ID],
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:tinyman:v2:addLiquidity:flexible",
          action: "addLiquidity",
          variant: "flexible",
          requiredInputs: ["assetAAmount", "assetBAmount"],
          requiredAssetIds: [USDC_ASSET_ID, ALGO_ASSET_ID],
          inputHints: {
            assetAId: USDC_ASSET_ID,
            assetBId: ALGO_ASSET_ID,
            poolId: "2PIFZW53RHCSFSYMCFUBW4XOCXOMB7XOYQSQ6KGT3KVGJTL4HM6COZRNMM",
          },
        }),
      ],
    });
    const held = position({
      protocol: "tinyman",
      opportunityId: candidate.opportunityId,
      assetId: 1_002_590_888,
      amountRaw: "12345",
      compatibleExitShapeKeys: [
        "mainnet:tinyman:v2:removeLiquidity:multipleAssetsOut",
      ],
    });

    const exit = buildExitAction({
      id: "tinyman-lp-exit",
      position: held,
      opportunity: candidate,
      exitShapeKey: "mainnet:tinyman:v2:removeLiquidity:multipleAssetsOut",
    });
    expect(exit.executionInput).toBeNull();

    const plan = normalizePortfolioPlan(
      portfolioPlan({
        actions: [exit],
        currentAllocations: [
          {
            key: "liquid",
            protocol: null,
            opportunityId: null,
            assetIds: [0],
            weightPct: 100,
            expectedApyPct: 0,
          },
        ],
        targetAllocations: [
          {
            key: "liquid",
            protocol: null,
            opportunityId: null,
            assetIds: [0],
            weightPct: 100,
            expectedApyPct: 0,
          },
        ],
      }),
      [candidate],
      portfolioSnapshot({ positions: [held] }),
    );

    expect(plan.actions[0]?.executionInput).toMatchObject({
      assetAId: USDC_ASSET_ID,
      assetBId: ALGO_ASSET_ID,
      poolTokenAmount: "12345",
      poolId: "2PIFZW53RHCSFSYMCFUBW4XOCXOMB7XOYQSQ6KGT3KVGJTL4HM6COZRNMM",
    });
  });

  it("is agent-minimal; host normalize completes Folks withdraw in asset units", () => {
    const candidate = opportunity({
      protocol: "folks-finance",
      opportunityId: "folks-lending-1",
      assetIds: [USDC_ASSET_ID],
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:folks-finance:v2:deposit:escrow",
          protocol: "folks-finance",
          action: "deposit",
          variant: "escrow",
          requiredInputs: ["assetAmount"],
          requiredAssetIds: [USDC_ASSET_ID],
          inputHints: { poolAppId: 971_372_237, assetId: USDC_ASSET_ID },
        }),
      ],
    });
    const held = position({
      protocol: "folks-finance",
      opportunityId: candidate.opportunityId,
      assetId: USDC_ASSET_ID,
      amountRaw: "999999",
      compatibleExitShapeKeys: [
        "mainnet:folks-finance:v2:withdraw:escrow",
      ],
    });

    const exit = buildExitAction({
      id: "folks-exit",
      position: held,
      opportunity: candidate,
      exitShapeKey: "mainnet:folks-finance:v2:withdraw:escrow",
      withdrawAmountRaw: "1000000",
    });
    expect(exit.executionInput).toBeNull();

    const plan = normalizePortfolioPlan(
      portfolioPlan({
        actions: [exit],
        currentAllocations: [
          {
            key: "liquid",
            protocol: null,
            opportunityId: null,
            assetIds: [0],
            weightPct: 100,
            expectedApyPct: 0,
          },
        ],
        targetAllocations: [
          {
            key: "liquid",
            protocol: null,
            opportunityId: null,
            assetIds: [0],
            weightPct: 100,
            expectedApyPct: 0,
          },
        ],
      }),
      [candidate],
      portfolioSnapshot({ positions: [held] }),
    );

    expect(plan.actions[0]?.executionInput).toMatchObject({
      amount: "1000000",
      amountDenomination: "asset",
      poolAppId: 971_372_237,
    });
    expect(plan.actions[0]?.executionInput).not.toHaveProperty("assetId");
  });
});

describe("loadProtocolVerifyConfig", () => {
  it("requires TEST_WALLET to match TEST_MNEMONIC", () => {
    const account = algosdk.generateAccount();
    const mnemonic = algosdk.secretKeyToMnemonic(account.sk);
    const config = loadProtocolVerifyConfig({
      TEST_WALLET: account.addr.toString(),
      TEST_MNEMONIC: mnemonic,
    });
    expect(config.PROTOCOL_VERIFY_AMOUNT_USDC).toBe(1);
    expect(config.PROTOCOL_VERIFY_AMOUNT_ALGO).toBe(1);
    expect(config.PROTOCOL_VERIFY_AMOUNT_ORA).toBe(1);
    expect(config.FOLKS_ESCROW_DATA_DIR).toBe("data/folks-escrows-verify");

    expect(() =>
      loadProtocolVerifyConfig({
        TEST_WALLET:
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
        TEST_MNEMONIC: mnemonic,
      }),
    ).toThrow(/TEST_WALLET must match TEST_MNEMONIC/);
  });
});
