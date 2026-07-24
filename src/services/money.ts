import { Decimal } from "decimal.js";

Decimal.set({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
});

export type Money = Decimal;

export function money(
  value: string | number | Decimal | null | undefined,
): Money {
  if (value === null || value === undefined) {
    throw new Error("Money value is required");
  }
  const parsed = new Decimal(value);
  if (!parsed.isFinite()) {
    throw new Error(`Money value is not finite: ${String(value)}`);
  }
  return parsed;
}

export function moneyOrNull(
  value: string | number | Decimal | null | undefined,
): Money | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = new Decimal(value);
  return parsed.isFinite() ? parsed : null;
}

export function formatMoney(value: Money): string {
  return value.toFixed();
}

/** Format a USD amount to exactly 2 decimal places (half-up). */
export function formatUsd(value: Money): string {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

export function sumMoney(
  values: Array<Money | null | undefined>,
): Money | null {
  let total: Money | null = null;
  for (const value of values) {
    if (value === null || value === undefined) {
      return null;
    }
    total = total === null ? value : total.plus(value);
  }
  return total ?? money(0);
}

export function subtractMoney(
  left: Money | null,
  right: Money | null,
): Money | null {
  if (left === null || right === null) {
    return null;
  }
  return left.minus(right);
}

/** Format integer on-chain base units with asset decimals (no float rounding). */
export function formatBaseUnits(amountRaw: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }
  if (!/^[0-9]+$/.test(amountRaw)) {
    throw new Error(`Invalid amountRaw: ${amountRaw}`);
  }
  if (decimals === 0) {
    return amountRaw.replace(/^0+(?=\d)/, "") || "0";
  }
  const padded = amountRaw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals).replace(/^0+(?=\d)/, "") || "0";
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}
