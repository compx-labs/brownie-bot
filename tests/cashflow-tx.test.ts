import { describe, expect, it, vi } from "vitest";

import {
  assertCashflowDirection,
  CashflowTxError,
  CashflowTxResolver,
  parseCashflowTransfer,
  type IndexerTransactionLike,
} from "../src/integrations/algorand/cashflow-tx.js";

const WALLET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";
const OTHER = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQKJQ";

describe("parseCashflowTransfer", () => {
  it("parses ALGO payments", () => {
    const tx: IndexerTransactionLike = {
      "tx-type": "pay",
      sender: OTHER,
      "round-time": 1_700_000_000,
      "payment-transaction": { amount: 1_500_000, receiver: WALLET },
    };
    expect(parseCashflowTransfer(tx, "TXPAY")).toMatchObject({
      transactionId: "TXPAY",
      assetId: 0,
      amountRaw: "1500000",
      sender: OTHER,
      receiver: WALLET,
      roundTimeSeconds: 1_700_000_000,
    });
  });

  it("parses ASA transfers", () => {
    const tx: IndexerTransactionLike = {
      "tx-type": "axfer",
      sender: OTHER,
      "asset-transfer-transaction": {
        amount: "1000000",
        receiver: WALLET,
        "asset-id": 31_566_704,
      },
    };
    expect(parseCashflowTransfer(tx, "TXASA")).toMatchObject({
      assetId: 31_566_704,
      amountRaw: "1000000",
      receiver: WALLET,
    });
  });

  it("parses algosdk camelCase axfer payloads", () => {
    const tx: IndexerTransactionLike = {
      txType: "axfer",
      sender: OTHER,
      confirmedRound: 63_617_907n,
      roundTime: 1_785_490_765,
      assetTransferTransaction: {
        amount: "6000000",
        receiver: WALLET,
        assetId: "31566704",
      },
    };
    expect(parseCashflowTransfer(tx, "TXCAMEL")).toMatchObject({
      assetId: 31_566_704,
      amountRaw: "6000000",
      receiver: WALLET,
      roundTimeSeconds: 1_785_490_765,
    });
  });

  it("rejects zero-amount axfers and unsupported types", () => {
    expect(() =>
      parseCashflowTransfer(
        {
          "tx-type": "axfer",
          sender: OTHER,
          "asset-transfer-transaction": {
            amount: 0,
            receiver: WALLET,
            "asset-id": 31_566_704,
          },
        },
        "TX0",
      ),
    ).toThrow(/zero/i);

    expect(() =>
      parseCashflowTransfer(
        { "tx-type": "appl", sender: OTHER },
        "TXAPP",
      ),
    ).toThrow(/Unsupported transaction type/);
  });
});

describe("readConfirmedRound", () => {
  it("reads camelCase bigint confirmedRound from algosdk", async () => {
    const { readConfirmedRound } = await import(
      "../src/integrations/algorand/cashflow-tx.js"
    );
    expect(
      readConfirmedRound({ confirmedRound: 63_617_907n }),
    ).toBe(63_617_907n);
    expect(readConfirmedRound({ "confirmed-round": 12 })).toBe(12n);
    expect(readConfirmedRound({})).toBeUndefined();
  });
});

describe("assertCashflowDirection", () => {
  it("requires wallet as receiver for deposits and sender for withdraws", () => {
    expect(() =>
      assertCashflowDirection(
        { sender: OTHER, receiver: WALLET },
        WALLET,
        "deposit",
      ),
    ).not.toThrow();
    expect(() =>
      assertCashflowDirection(
        { sender: OTHER, receiver: OTHER },
        WALLET,
        "deposit",
      ),
    ).toThrow(CashflowTxError);

    expect(() =>
      assertCashflowDirection(
        { sender: WALLET, receiver: OTHER },
        WALLET,
        "withdraw",
      ),
    ).not.toThrow();
    expect(() =>
      assertCashflowDirection(
        { sender: OTHER, receiver: WALLET },
        WALLET,
        "withdraw",
      ),
    ).toThrow(/sender/i);
  });
});

describe("CashflowTxResolver", () => {
  it("resolves a confirmed axfer deposit with asset metadata", async () => {
    const lookupTransactionByID = vi.fn().mockReturnValue({
      do: async () => ({
        transaction: {
          txType: "axfer",
          sender: OTHER,
          confirmedRound: 12_345n,
          roundTime: 1_700_000_000,
          assetTransferTransaction: {
            amount: "2500000",
            receiver: WALLET,
            assetId: "31566704",
          },
        },
      }),
    });
    const getAssetByID = vi.fn().mockReturnValue({
      do: async () => ({
        params: { decimals: 6, unitName: "USDC" },
      }),
    });

    const resolver = new CashflowTxResolver({
      indexerUrl: "https://example.invalid",
      algodUrl: "https://example.invalid",
      walletAddress: WALLET,
      indexer: { lookupTransactionByID },
      algod: { getAssetByID },
    });

    await expect(resolver.resolve("TXUSDC", "deposit")).resolves.toMatchObject({
      transactionId: "TXUSDC",
      assetId: 31_566_704,
      amountRaw: "2500000",
      decimals: 6,
      symbol: "USDC",
      counterparty: OTHER,
      occurredAt: "2023-11-14T22:13:20.000Z",
    });
  });

  it("rejects unconfirmed transactions", async () => {
    const resolver = new CashflowTxResolver({
      indexerUrl: "https://example.invalid",
      algodUrl: "https://example.invalid",
      walletAddress: WALLET,
      indexer: {
        lookupTransactionByID: vi.fn().mockReturnValue({
          do: async () => ({
            transaction: {
              "tx-type": "pay",
              sender: OTHER,
              "confirmed-round": 0,
              "payment-transaction": { amount: 1, receiver: WALLET },
            },
          }),
        }),
      },
      algod: {
        getAssetByID: vi.fn(),
      },
    });

    await expect(resolver.resolve("TXPEND", "deposit")).rejects.toThrow(
      /not confirmed/i,
    );
  });
});
