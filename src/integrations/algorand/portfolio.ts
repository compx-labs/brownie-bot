import algosdk from "algosdk";

import type {
  LiquidBalance,
  PaymentReceipt,
  PortfolioSnapshot,
} from "../../domain.js";
import type { Canix402Client } from "../canix402/client.js";
import {
  collectRepriceAssetIds,
  recomputeWalletPositionTotals,
  repricePositionsFromTokenPrices,
} from "../../services/position-pricing.js";

export interface PortfolioReader {
  read(): Promise<{
    snapshot: PortfolioSnapshot;
    payments: PaymentReceipt[];
  }>;
}

export class AlgorandPortfolioReader implements PortfolioReader {
  constructor(
    private readonly canix: Canix402Client,
    private readonly address: string,
    private readonly algodUrl: string,
    private readonly maxSourceAgeHours: number,
  ) {}

  async read(): Promise<{
    snapshot: PortfolioSnapshot;
    payments: PaymentReceipt[];
  }> {
    const [{ positions, payment }, accountState] = await Promise.all([
      this.canix.getPositions(this.address),
      this.readAccountState(),
    ]);
    const repriceAssetIds = collectRepriceAssetIds(positions.data);
    const prices =
      repriceAssetIds.length === 0
        ? []
        : await this.canix.getTokenPrices(repriceAssetIds);
    const { positions: pricedPositions } = repricePositionsFromTokenPrices(
      positions.data,
      prices,
    );
    const totals = recomputeWalletPositionTotals(pricedPositions);
    const caveats: string[] = [];
    if (accountState.authAddress) {
      caveats.push(
        `Treasury account is rekeyed to ${accountState.authAddress}; local signing requires that authorized signer`,
      );
    }
    for (const protocol of positions.protocols) {
      if (protocol.status !== "ok") {
        caveats.push(
          `${protocol.protocol} positions are ${protocol.status}: ${protocol.message ?? "no details"}`,
        );
      }
    }
    const oldestAllowed = Date.now() - this.maxSourceAgeHours * 3_600_000;
    for (const position of pricedPositions) {
      if (
        position.sourceTimestamp &&
        new Date(position.sourceTimestamp).getTime() < oldestAllowed
      ) {
        caveats.push(
          `Position ${position.positionId} source data exceeds ${this.maxSourceAgeHours} hours`,
        );
      }
    }
    if (Object.values(totals).some((value) => value === null)) {
      caveats.push("At least one aggregate position valuation is incomplete");
    }
    return {
      snapshot: {
        address: this.address,
        fetchedAt: new Date().toISOString(),
        positions: pricedPositions,
        protocols: positions.protocols,
        totals,
        liquidBalances: accountState.balances,
        minimumBalanceRaw: accountState.minimumBalanceRaw,
        complete: caveats.length === 0,
        caveats,
      },
      payments: payment ? [payment] : [],
    };
  }

  private async readAccountState(): Promise<{
    balances: LiquidBalance[];
    minimumBalanceRaw: string;
    authAddress?: string;
  }> {
    const algod = new algosdk.Algodv2("", this.algodUrl, "");
    const account = (await algod.accountInformation(this.address).do()) as {
      amount: bigint | number;
      minBalance?: bigint | number;
      authAddr?: { toString(): string } | string;
      assets?: Array<{
        assetId?: bigint | number;
        amount: bigint | number;
        isFrozen?: boolean;
      }>;
    };
    const amount = BigInt(account.amount);
    const minimumBalance = BigInt(account.minBalance ?? 0);
    const balances: LiquidBalance[] = [
      {
        assetId: 0,
        amountRaw: amount.toString(),
        spendableAmountRaw:
          amount > minimumBalance ? (amount - minimumBalance).toString() : "0",
        decimals: 6,
        symbol: "ALGO",
      },
    ];
    const assets = (account.assets ?? []).filter(
      (asset): asset is typeof asset & { assetId: bigint | number } =>
        asset.assetId !== undefined,
    );
    const assetParameters = await Promise.all(
      assets.map(async (asset) => {
        const response = (await algod.getAssetByID(asset.assetId).do()) as {
          params?: {
            decimals?: number | bigint;
            unitName?: string;
          };
        };
        return response.params;
      }),
    );
    assets.forEach((asset, index) => {
      balances.push({
        assetId: Number(asset.assetId),
        amountRaw: asset.amount.toString(),
        spendableAmountRaw: asset.isFrozen ? "0" : asset.amount.toString(),
        decimals:
          assetParameters[index]?.decimals === undefined
            ? undefined
            : Number(assetParameters[index]?.decimals),
        symbol: assetParameters[index]?.unitName,
        frozen: asset.isFrozen ?? false,
      });
    });
    const authAddress = account.authAddr?.toString();
    return {
      balances,
      minimumBalanceRaw: minimumBalance.toString(),
      authAddress:
        authAddress && authAddress !== this.address ? authAddress : undefined,
    };
  }
}
