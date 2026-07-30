import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConsoleNotifier,
  describeReviewExecutionGate,
  escapeHtml,
  escapeRichMarkdown,
  formatAccountingTelegramReport,
  formatAccountingTelegramReportRich,
  formatTelegramReport,
  formatTelegramReportRich,
  TelegramNotifier,
} from "../src/services/telegram.js";
import { opportunity, portfolioPlan, portfolioSnapshot } from "./fixtures.js";

describe("formatTelegramReport", () => {
  it("formats autonomous plan and payment details", () => {
    const report = formatTelegramReport({
      id: "run-1",
      startedAt: "2026-07-13T09:00:00.000Z",
      completedAt: "2026-07-13T09:00:01.000Z",
      status: "no-op",
      mode: "autonomous",
      signingEnabled: false,
      walletAddress:
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
      snapshot: portfolioSnapshot(),
      plan: portfolioPlan({
        confidence: 0.85,
        risks: ["Yield is variable."],
      }),
      policy: {
        approved: true,
        violations: [],
        warnings: [],
        metrics: {
          maxPositionPct: 10,
          maxProtocolPct: 20,
          liquidReservePct: 50,
          turnoverPct: 0,
        },
      },
      opportunities: [],
      payments: [
        {
          amountBaseUnits: "50000",
          assetId: "31566704",
          network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
          responseHeader: "settled",
        },
      ],
      inferenceCost: {
        totalUsdc: "0.0042",
        requestCount: 1,
        charges: [
          {
            amountUsdc: "0.0042",
            headers: { "x-zs-inference-amount": "0.0042" },
          },
        ],
      },
    });

    expect(report).toContain("Treasury portfolio run: no-op");
    expect(report).toContain("Mode: autonomous");
    expect(report).toContain("Signing: disabled");
    expect(report).toContain("Policy: approved");
    expect(report).toContain("Execution: dry-run only (no txs)");
    expect(report).toContain("Plan confidence: 85%");
    expect(report).toContain("50000 USDC base units");
    expect(report).toContain(
      "ZeroSignal inference: 1 request(s), $0.0042 USDC",
    );
  });

  it("reports policy notes without treating them as blocks", () => {
    const report = formatTelegramReport({
      id: "run-2",
      startedAt: "2026-07-13T09:00:00.000Z",
      completedAt: "2026-07-13T09:00:01.000Z",
      status: "validated-dry-run",
      mode: "autonomous",
      signingEnabled: false,
      walletAddress:
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
      snapshot: portfolioSnapshot({
        complete: false,
        caveats: ["folks positions are unavailable: timeout"],
      }),
      plan: portfolioPlan(),
      policy: {
        approved: true,
        violations: [],
        warnings: [
          "Portfolio snapshot is incomplete (folks positions are unavailable: timeout); signing is disabled so the plan is still reported",
          "Target position 52.57% exceeds guidance of 35%",
        ],
        metrics: {
          maxPositionPct: 52.57,
          maxProtocolPct: 40,
          liquidReservePct: 20,
          turnoverPct: 10,
        },
      },
      opportunities: [],
      payments: [],
    });

    expect(report).toContain("Policy notes:");
    expect(report).toContain("folks positions are unavailable: timeout");
    expect(report).toContain("exceeds guidance of 35%");
    expect(report).not.toContain("Policy blocked:");
  });

  it("formats reported runs with unstructured agent report text", () => {
    const report = formatTelegramReport({
      id: "run-reported-1",
      startedAt: "2026-07-13T09:00:00.000Z",
      completedAt: "2026-07-13T09:00:01.000Z",
      status: "reported",
      mode: "autonomous",
      signingEnabled: false,
      walletAddress:
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
      snapshot: portfolioSnapshot(),
      planRawText:
        '{"portfolio_plan":{"summary":{"narrative":"Deploy idle USDC"}}}',
      planParseError:
        "Portfolio agent returned an invalid structured plan: actions.0.id: Required",
      opportunities: [opportunity()],
      payments: [],
    });

    expect(report).toContain("Treasury portfolio run: reported");
    expect(report).toContain("Structured plan parse note:");
    expect(report).toContain("Agent report:");
    expect(report).toContain("Deploy idle USDC");
    expect(report).not.toContain("Plan confidence:");
  });
});

describe("formatTelegramReportRich", () => {
  it("formats bold labels, action table, Allo link, and escaped summary", () => {
    const report = formatTelegramReportRich({
      id: "run-rich-1",
      startedAt: "2026-07-13T09:00:00.000Z",
      completedAt: "2026-07-13T09:00:01.000Z",
      status: "confirmed",
      mode: "autonomous",
      signingEnabled: true,
      walletAddress:
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
      snapshot: portfolioSnapshot(),
      plan: portfolioPlan({
        confidence: 0.9,
        projectedNetBenefitUsd: 12.5,
        summary: "Open *new* position with _italic_ and `code` risk.",
        risks: ["Smart contract risk *exists*."],
        actions: [
          {
            id: "a1",
            type: "open",
            protocol: "folks",
            opportunityId: "opp-1",
            positionId: null,
            amountRaw: "1000000",
            fromAssetId: 31566704,
            toAssetId: null,
            targetWeightPct: 20,
            executionShapeKey: "folks.supply",
            executionInput: {},
            authorizedSpends: [{ assetId: 31566704, amountRaw: "1000000" }],
            rationale: "Diversify into Folks supply.",
            dependencies: [],
          },
        ],
      }),
      policy: {
        approved: true,
        violations: [],
        warnings: [],
        metrics: {
          maxPositionPct: 20,
          maxProtocolPct: 20,
          liquidReservePct: 50,
          turnoverPct: 5,
        },
      },
      executions: [
        {
          actionId: "a1",
          status: "confirmed",
          transactionId:
            "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
        },
      ],
      opportunities: [opportunity()],
      payments: [
        {
          amountBaseUnits: "10000",
          assetId: "31566704",
          network: "algorand:mainnet",
        },
      ],
      inferenceCost: {
        totalUsdc: "0.01",
        requestCount: 2,
        charges: [],
      },
    });

    expect(report).toContain("### Treasury review · confirmed");
    expect(report).toContain("**Signing** enabled");
    expect(report).toContain("**Policy** approved");
    expect(report).toContain("**Execution** submitted (1 confirmed)");
    expect(report).toContain("### Plan");
    expect(report).toContain("### Actions");
    expect(report).toContain("| Action | Status | Detail |");
    expect(report).toContain("open · folks");
    expect(report).toContain("confirmed");
    expect(report).toContain(
      "https://allo.info/tx/ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
    );
    expect(report).toContain("<details>");
    expect(report).toContain("<summary>Risks / policy notes</summary>");
    expect(report).toContain("### Spend");
    expect(report).toContain(
      escapeRichMarkdown("Open *new* position with _italic_ and `code` risk."),
    );
    expect(report).toContain(
      escapeRichMarkdown("Smart contract risk *exists*."),
    );
  });

  it("formats reported status with agent report body", () => {
    const report = formatTelegramReportRich({
      id: "run-reported-rich",
      startedAt: "2026-07-13T09:00:00.000Z",
      completedAt: "2026-07-13T09:00:01.000Z",
      status: "reported",
      mode: "autonomous",
      signingEnabled: false,
      opportunities: [],
      planRawText: "Raw agent narrative about holding liquid USDC.",
      planParseError: "JSON parse failed: Unexpected token",
    });

    expect(report).toContain("### Treasury review · reported");
    expect(report).toContain("### Agent report");
    expect(report).toContain("Structured plan parse note:");
    expect(report).toContain("holding liquid USDC");
    expect(report).not.toContain("### Plan");
  });

  it("surfaces policy blocks and warnings in details", () => {
    const report = formatTelegramReportRich({
      id: "run-rich-2",
      startedAt: "2026-07-13T09:00:00.000Z",
      completedAt: "2026-07-13T09:00:01.000Z",
      status: "planned",
      mode: "autonomous",
      signingEnabled: true,
      snapshot: portfolioSnapshot(),
      plan: portfolioPlan({
        summary: "Blocked plan.",
        risks: ["Smart contract risk"],
        actions: [
          {
            id: "a1",
            type: "open",
            protocol: "folks",
            opportunityId: "opp-1",
            positionId: null,
            amountRaw: "1000000",
            fromAssetId: 31566704,
            toAssetId: null,
            targetWeightPct: 20,
            executionShapeKey: "folks.supply",
            executionInput: {},
            authorizedSpends: [{ assetId: 31566704, amountRaw: "1000000" }],
            rationale: "Would open Folks.",
            dependencies: [],
          },
        ],
      }),
      policy: {
        approved: false,
        violations: ["Turnover exceeds hard limit"],
        warnings: ["Snapshot incomplete"],
        metrics: {
          maxPositionPct: 10,
          maxProtocolPct: 10,
          liquidReservePct: 50,
          turnoverPct: 90,
        },
      },
      opportunities: [],
      payments: [],
      error: "Policy rejected the plan *hard*.",
    });

    expect(report).toContain("**Signing** enabled");
    expect(report).toContain("**Policy** blocked");
    expect(report).toContain("**Execution** not submitted");
    expect(report).toContain("### Policy blocked");
    expect(report).toContain("Turnover exceeds hard limit");
    expect(report).toContain("**Error:**");
    expect(report).toContain(
      escapeRichMarkdown("Policy rejected the plan *hard*."),
    );
    expect(report).toContain("**Blocked:**");
    expect(report).toContain("Snapshot incomplete");
    expect(report).toContain("not executed");
    expect(report).toContain("policy blocked");
  });
});

describe("describeReviewExecutionGate", () => {
  it("distinguishes policy block from signing-disabled dry-run", () => {
    expect(
      describeReviewExecutionGate({
        id: "r1",
        startedAt: "2026-07-13T09:00:00.000Z",
        completedAt: "2026-07-13T09:00:01.000Z",
        status: "planned",
        mode: "autonomous",
        signingEnabled: true,
        plan: portfolioPlan(),
        policy: {
          approved: false,
          violations: ["Too much turnover"],
          warnings: [],
          metrics: {
            maxPositionPct: 1,
            maxProtocolPct: 1,
            liquidReservePct: 1,
            turnoverPct: 99,
          },
        },
        opportunities: [],
      }),
    ).toMatchObject({
      execution: "not submitted",
      policy: "blocked",
      signing: "enabled",
    });

    expect(
      describeReviewExecutionGate({
        id: "r2",
        startedAt: "2026-07-13T09:00:00.000Z",
        completedAt: "2026-07-13T09:00:01.000Z",
        status: "validated-dry-run",
        mode: "autonomous",
        signingEnabled: false,
        plan: portfolioPlan(),
        policy: {
          approved: true,
          violations: [],
          warnings: [],
          metrics: {
            maxPositionPct: 1,
            maxProtocolPct: 1,
            liquidReservePct: 50,
            turnoverPct: 0,
          },
        },
        executions: [
          { actionId: "a1", status: "validated-dry-run" },
        ],
        opportunities: [],
      }),
    ).toMatchObject({
      execution: "dry-run only (no txs)",
      policy: "approved",
      signing: "disabled",
    });
  });
});

describe("formatAccountingTelegramReport", () => {
  it("reports DeFi, wallet ASA total, ALGO, and P&L", () => {
    const report = formatAccountingTelegramReport({
      id: "acc-1",
      startedAt: "2026-07-16T08:00:00.000Z",
      completedAt: "2026-07-16T08:00:01.000Z",
      status: "completed",
      snapshotKey: "wallets/W/snapshots/2026/07/16/acc-1.json",
      summary: {
        schemaVersion: 2,
        walletAddress: "W",
        asOf: "2026-07-16T08:00:00.000Z",
        latestSnapshotId: "acc-1",
        latestSnapshotKey: "wallets/W/snapshots/2026/07/16/acc-1.json",
        latestTotalValueUsd: "110.00",
        previousTotalValueUsd: "100.00",
        pnlUsd: "10.00",
        pnlAvailable: true,
        navDeltaUsd: "110.00",
        netExternalCashflowUsd: "100.00",
        defiByProtocol: [
          { protocol: "folks", valueUsd: "80.00", positionCount: 2 },
          { protocol: "tinyman", valueUsd: "20.00", positionCount: 1 },
        ],
        defiValueUsd: "100.00",
        walletAsaValueUsd: "10.00",
        unpricedAssetIds: [],
        algoBalance: "12.5",
        minimumBalance: "0.2",
        notes: [],
        checksum: "abc",
      },
    });
    expect(report).toContain("Treasury accounting run: completed");
    expect(report).toContain("folks: $80.00 (2)");
    expect(report).toContain("Wallet tokens total: $10.00");
    expect(report).toContain("ALGO balance: 12.5");
    expect(report).toContain("Account min balance: 0.2");
    expect(report).toContain("P&L vs previous: $10.00");
    expect(report).toContain("External funding (window): $100.00");
  });

  it("reports no previous baseline and unpriced ASAs without failing language", () => {
    const report = formatAccountingTelegramReport({
      id: "acc-2",
      startedAt: "2026-07-16T08:00:00.000Z",
      completedAt: "2026-07-16T08:00:01.000Z",
      status: "completed",
      summary: {
        schemaVersion: 2,
        walletAddress: "W",
        asOf: "2026-07-16T08:00:00.000Z",
        latestSnapshotId: "acc-2",
        latestSnapshotKey: "key",
        latestTotalValueUsd: "5",
        previousTotalValueUsd: null,
        pnlUsd: null,
        pnlAvailable: false,
        defiByProtocol: [],
        defiValueUsd: "0",
        walletAsaValueUsd: "5",
        unpricedAssetIds: [1_164_556_102],
        algoBalance: "1",
        minimumBalance: "0.1",
        notes: [
          "No previous accounting baseline; P&L not available yet",
          "Missing USD price for asset 1164556102",
        ],
        checksum: "abc",
      },
    });
    expect(report).toContain("DeFi positions:");
    expect(report).toContain("none");
    expect(report).toContain("P&L vs previous: no previous baseline");
    expect(report).toContain("Unpriced ASAs: 1164556102");
    expect(report).not.toContain("Caveats:");
  });
});

describe("formatAccountingTelegramReportRich", () => {
  it("formats protocol table and notes details", () => {
    const report = formatAccountingTelegramReportRich({
      id: "acc-rich-1",
      startedAt: "2026-07-16T08:00:00.000Z",
      completedAt: "2026-07-16T08:00:01.000Z",
      status: "completed",
      snapshotKey: "wallets/W/snapshots/2026/07/16/acc-1.json",
      summary: {
        schemaVersion: 2,
        walletAddress: "W",
        asOf: "2026-07-16T08:00:00.000Z",
        latestSnapshotId: "acc-1",
        latestSnapshotKey: "wallets/W/snapshots/2026/07/16/acc-1.json",
        latestTotalValueUsd: "110.00",
        previousTotalValueUsd: "100.00",
        pnlUsd: "10.00",
        pnlAvailable: true,
        defiByProtocol: [
          { protocol: "folks", valueUsd: "80.00", positionCount: 2 },
          { protocol: "tinyman", valueUsd: "20.00", positionCount: 1 },
        ],
        defiValueUsd: "100.00",
        walletAsaValueUsd: "10.00",
        unpricedAssetIds: [42],
        algoBalance: "12.5",
        minimumBalance: "0.2",
        notes: ["Price feed *stale* for asset 42"],
        checksum: "abc",
      },
    });

    expect(report).toContain("### Treasury accounting · completed");
    expect(report).toContain("### DeFi by protocol");
    expect(report).toContain("| Protocol | Value | Positions |");
    expect(report).toContain("| folks | $80.00 | 2 |");
    expect(report).toContain("### Wallet");
    expect(report).toContain("P&L vs previous: **$10.00**");
    expect(report).toContain("<summary>Notes</summary>");
    expect(report).toContain("Unpriced ASAs: 42");
    expect(report).toContain(
      escapeRichMarkdown("Price feed *stale* for asset 42"),
    );
  });
});

describe("escape helpers", () => {
  it("escapes rich markdown metacharacters", () => {
    expect(escapeRichMarkdown("a *b* _c_ `d` | e")).toBe(
      "a \\*b\\* \\_c\\_ \\`d\\` \\| e",
    );
  });

  it("escapes HTML metacharacters", () => {
    expect(escapeHtml("a <b> & c")).toBe("a &lt;b&gt; &amp; c");
  });
});

describe("ConsoleNotifier", () => {
  it("prints review reports to stdout", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const notifier = new ConsoleNotifier();
    await notifier.send({
      id: "run-1",
      startedAt: "2026-07-13T09:00:00.000Z",
      completedAt: "2026-07-13T09:00:01.000Z",
      status: "no-op",
      mode: "autonomous",
      signingEnabled: false,
      walletAddress:
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
      snapshot: portfolioSnapshot(),
      plan: portfolioPlan(),
      opportunities: [],
      payments: [],
    });
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]?.[0])).toContain(
      "Treasury portfolio run: no-op",
    );
    log.mockRestore();
  });
});

describe("TelegramNotifier", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends rich markdown and falls back to HTML then plain", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({ ok: false, description: "rich unavailable" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({ ok: false, description: "html unavailable" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = new TelegramNotifier("token", "chat-1");
    await notifier.send({
      id: "run-1",
      startedAt: "2026-07-13T09:00:00.000Z",
      completedAt: "2026-07-13T09:00:01.000Z",
      status: "no-op",
      mode: "autonomous",
      signingEnabled: false,
      snapshot: portfolioSnapshot(),
      plan: portfolioPlan(),
      opportunities: [],
      payments: [],
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("sendRichMessage");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("sendMessage");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("sendMessage");

    const richInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(typeof richInit?.body).toBe("string");
    const richBody = JSON.parse(richInit?.body as string) as {
      rich_message: { markdown: string };
    };
    expect(richBody.rich_message.markdown).toContain(
      "### Treasury review · no-op",
    );

    const htmlInit = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
    expect(typeof htmlInit?.body).toBe("string");
    const htmlBody = JSON.parse(htmlInit?.body as string) as {
      parse_mode: string;
      text: string;
    };
    expect(htmlBody.parse_mode).toBe("HTML");
    expect(htmlBody.text).toContain("<b>Treasury review");
  });
});
