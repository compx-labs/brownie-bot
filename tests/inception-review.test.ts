import { describe, expect, it, vi } from "vitest";

import type { InceptionReview } from "../src/domain.js";
import { canonicalChecksum } from "../src/integrations/storage/accounting-store.js";
import { InceptionReviewService } from "../src/services/inception-review.js";

describe("InceptionReviewService.commitReview", () => {
  it("records external rows and writes inception", async () => {
    const cashflows: unknown[] = [];
    const store = {
      getInception: vi.fn().mockResolvedValue(undefined),
      putInception: vi.fn().mockResolvedValue("inception"),
      getCashflowByEventId: vi.fn().mockResolvedValue(undefined),
      getInceptionReview: vi.fn(),
      putInceptionReview: vi.fn(),
    };
    const accounting = {
      recordCashflow: vi.fn((input: unknown) => {
        cashflows.push(input);
        return Promise.resolve(input);
      }),
    };
    const service = new InceptionReviewService(
      store as never,
      { getTokenPrices: vi.fn() },
      accounting as never,
      {
        walletAddress: "WALLET",
        indexerUrl: "https://example.invalid",
        algodUrl: "https://example.invalid",
      },
    );

    const rows = [
      {
        transactionId: "TX1",
        confirmedRound: 63_163_100,
        occurredAt: "2026-07-17T00:00:00.000Z",
        txType: "axfer",
        assetId: 31_566_704,
        symbol: "USDC",
        decimals: 6,
        amountRaw: "1000000",
        amountLabel: "1 USDC",
        amountUsd: "1.00",
        sender: "OTHER",
        receiver: "WALLET",
        counterparty: "OTHER",
        groupId: null,
        classification: "external_deposit" as const,
      },
      {
        transactionId: "TX2",
        confirmedRound: 63_163_200,
        occurredAt: "2026-07-18T00:00:00.000Z",
        txType: "axfer",
        assetId: 31_566_704,
        symbol: "USDC",
        decimals: 6,
        amountRaw: "500000",
        amountLabel: "0.5 USDC",
        amountUsd: "0.50",
        sender: "WALLET",
        receiver: "OTHER",
        counterparty: "OTHER",
        groupId: "abc",
        classification: "flagged" as const,
        flagReason: "appl in group",
      },
    ];
    const withoutChecksum = {
      schemaVersion: 1 as const,
      walletAddress: "WALLET",
      minRound: 63_163_056,
      asOf: "2026-07-16T21:21:50.000Z",
      generatedAt: "2026-08-06T12:00:00.000Z",
      proposedInceptionNavUsd: "10.00",
      proposedDepositsUsd: "1.00",
      proposedWithdrawalsUsd: "0",
      priceNote: "note",
      rows,
    };
    const review: InceptionReview = {
      ...withoutChecksum,
      checksum: canonicalChecksum(withoutChecksum),
    };

    const result = await service.commitReview({ review });
    expect(result.recordedCashflows).toBe(1);
    expect(result.skippedCashflows).toBe(0);
    expect(result.inception.navUsd).toBe("10.00");
    expect(store.putInception).toHaveBeenCalledOnce();
    expect(accounting.recordCashflow).toHaveBeenCalledOnce();
  });

  it("refuses overwrite without force", async () => {
    const store = {
      getInception: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        walletAddress: "WALLET",
        asOf: "2026-07-16T21:21:50.000Z",
        navUsd: "1.00",
        minRound: 1,
        recordedAt: "2026-08-01T00:00:00.000Z",
        reviewChecksum: "old",
      }),
      putInception: vi.fn(),
      getCashflowByEventId: vi.fn(),
    };
    const service = new InceptionReviewService(
      store as never,
      { getTokenPrices: vi.fn() },
      { recordCashflow: vi.fn() },
      {
        walletAddress: "WALLET",
        indexerUrl: "https://example.invalid",
        algodUrl: "https://example.invalid",
      },
    );
    await expect(
      service.commitReview({
        review: {
          schemaVersion: 1,
          walletAddress: "WALLET",
          minRound: 1,
          asOf: "2026-07-16T21:21:50.000Z",
          generatedAt: "2026-08-06T12:00:00.000Z",
          proposedInceptionNavUsd: "10.00",
          proposedDepositsUsd: "0",
          proposedWithdrawalsUsd: "0",
          priceNote: "note",
          checksum: "x",
          rows: [],
        },
      }),
    ).rejects.toThrow(/already set/);
  });
});
