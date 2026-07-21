import { formatMoney, money, moneyOrNull, type Money } from "./money.js";

/** One ZeroSignal inference charge extracted from zs-proxy response headers. */
export interface InferenceCostCharge {
  /** Settled inference amount in USDC (decimal string). */
  amountUsdc: string;
  /** Related `X-Zs-*` headers from that response (for debugging / breakdown). */
  headers: Record<string, string>;
}

export interface InferenceCostSummary {
  charges: InferenceCostCharge[];
  /** Sum of charge amounts in USDC (decimal string). */
  totalUsdc: string;
  requestCount: number;
}

const INFERENCE_AMOUNT_HEADER = "x-zs-inference-amount";

/**
 * Pull ZeroSignal cost headers from a Responses API HTTP response.
 * Primary amount is `X-Zs-Inference-Amount` (USDC decimal).
 */
export function parseInferenceCostFromHeaders(
  headers: Headers | Record<string, string> | undefined,
): InferenceCostCharge | undefined {
  if (!headers) {
    return undefined;
  }
  const zsHeaders = collectZsHeaders(headers);
  const rawAmount =
    zsHeaders[INFERENCE_AMOUNT_HEADER] ??
    lookupHeader(headers, INFERENCE_AMOUNT_HEADER);
  if (rawAmount === undefined || rawAmount.trim() === "") {
    return undefined;
  }
  const amount = moneyOrNull(rawAmount.trim());
  if (amount === null || amount.isNegative()) {
    return undefined;
  }
  return {
    amountUsdc: formatMoney(amount),
    headers: zsHeaders,
  };
}

export function summarizeInferenceCosts(
  charges: InferenceCostCharge[],
): InferenceCostSummary | undefined {
  if (charges.length === 0) {
    return undefined;
  }
  let total: Money = money(0);
  for (const charge of charges) {
    total = total.plus(money(charge.amountUsdc));
  }
  return {
    charges,
    totalUsdc: formatMoney(total),
    requestCount: charges.length,
  };
}

/** Format a short human line for Telegram / console reports. */
export function formatInferenceCostLine(
  summary: InferenceCostSummary | undefined,
): string | undefined {
  if (!summary) {
    return undefined;
  }
  return `ZeroSignal inference: ${summary.requestCount} request(s), $${summary.totalUsdc} USDC`;
}

function collectZsHeaders(
  headers: Headers | Record<string, string>,
): Record<string, string> {
  const collected: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      if (key.toLowerCase().startsWith("x-zs-")) {
        collected[key.toLowerCase()] = value;
      }
    });
    return collected;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase().startsWith("x-zs-") && typeof value === "string") {
      collected[key.toLowerCase()] = value;
    }
  }
  return collected;
}

function lookupHeader(
  headers: Headers | Record<string, string>,
  name: string,
): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && typeof value === "string") {
      return value;
    }
  }
  return undefined;
}
