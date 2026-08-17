import algosdk from "algosdk";

import type {
  LiquidBalance,
  PaymentReceipt,
  PortfolioSnapshot,
} from "../../domain.js";
import type { Canix402Client } from "../canix402/client.js";
import {
  collectRepriceAssetIds,
  priceLiquidBalances,
  recomputeWalletPositionTotals,
  repricePositionsFromTokenPrices,
} from "../../services/position-pricing.js";
import { sanitizeErrorMessage } from "../../util/errors.js";

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
    const [{ positions, payment }, claimableResult, accountState] =
      await Promise.all([
        this.canix.getPositions(this.address),
        this.readClaimable(),
        this.readAccountState(),
      ]);
    const repriceAssetIds = collectRepriceAssetIds(positions.data);
    const liquidAssetIds = accountState.balances.map(
      (balance) => balance.assetId,
    );
    const priceAssetIds = [
      ...new Set([...repriceAssetIds, ...liquidAssetIds]),
    ];
    const prices =
      priceAssetIds.length === 0
        ? []
        : await this.canix.getTokenPrices(priceAssetIds);
    const { positions: pricedPositions } = repricePositionsFromTokenPrices(
      positions.data,
      prices,
    );
    const liquidBalances = priceLiquidBalances(
      accountState.balances,
      prices,
    );
    const totals = recomputeWalletPositionTotals(pricedPositions);
    const hardCaveats: string[] = [];
    const softCaveats: string[] = [];
    if (accountState.authAddress) {
      hardCaveats.push(
        `Treasury account is rekeyed to ${accountState.authAddress}; local signing requires that authorized signer`,
      );
    }
    for (const protocol of positions.protocols) {
      if (protocol.status !== "ok") {
        hardCaveats.push(
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
        // Informational only — stale source timestamps must not mark the
        // snapshot incomplete or hard-block signing runs.
        softCaveats.push(
          `Position ${position.positionId} source data exceeds ${this.maxSourceAgeHours} hours`,
        );
      }
    }
    if (Object.values(totals).some((value) => value === null)) {
      hardCaveats.push("At least one aggregate position valuation is incomplete");
    }
    const caveats = [
      ...hardCaveats,
      ...softCaveats,
      ...claimableResult.caveats,
    ];
    return {
      snapshot: {
        address: this.address,
        fetchedAt: new Date().toISOString(),
        positions: pricedPositions,
        protocols: positions.protocols,
        totals,
        liquidBalances,
        minimumBalanceRaw: accountState.minimumBalanceRaw,
        complete: hardCaveats.length === 0,
        caveats,
        claimable: claimableResult.claimable,
      },
      payments: [
        ...(payment ? [payment] : []),
        ...(claimableResult.payment ? [claimableResult.payment] : []),
      ],
    };
  }

  private async readClaimable(): Promise<{
    claimable?: PortfolioSnapshot["claimable"];
    payment?: PaymentReceipt;
    caveats: string[];
  }> {
    try {
      const result = await this.canix.getClaimable(this.address);
      return {
        claimable: result.claimable,
        payment: result.payment,
        caveats: result.claimable.caveats,
      };
    } catch (error) {
      return {
        caveats: [`claim desk unavailable: ${sanitizeErrorMessage(error)}`],
      };
    }
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
