import type { ReviewRun } from "../domain.js";

export interface RunNotifier {
  send(run: ReviewRun): Promise<void>;
}

export class TelegramNotifier implements RunNotifier {
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
  ) {}

  async send(run: ReviewRun): Promise<void> {
    const response = await fetch(
      `https://api.telegram.org/bot${this.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: formatTelegramReport(run),
          disable_web_page_preview: true,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Telegram API returned HTTP ${response.status}`);
    }
  }
}

export function formatTelegramReport(run: ReviewRun): string {
  const heading = `Treasury portfolio run: ${run.status}`;
  const lines = [
    heading,
    `Mode: ${run.mode}`,
    `Signing: ${run.signingEnabled ? "enabled" : "disabled"}`,
    `Run: ${run.id}`,
    `Completed: ${run.completedAt}`,
  ];

  if (run.opportunities.length > 0) {
    lines.push(`Candidates reviewed: ${run.opportunities.length}`);
  }
  if (run.plan) {
    lines.push(
      `Plan confidence: ${formatNumber(run.plan.confidence * 100)}%`,
      `Projected net benefit: $${formatNumber(run.plan.projectedNetBenefitUsd)}`,
      `Summary: ${truncate(run.plan.summary, 700)}`,
    );
  }
  if (run.policy && !run.policy.approved) {
    lines.push(
      `Policy blocked: ${truncate(run.policy.violations.join("; "), 750)}`,
    );
  }
  for (const execution of run.executions ?? []) {
    lines.push(
      `Action ${execution.actionId}: ${execution.status}${execution.transactionId ? ` · ${execution.transactionId}` : ""}${execution.error ? ` · ${truncate(execution.error, 240)}` : ""}`,
    );
  }
  if (run.reconciledSnapshot) {
    lines.push(
      `Reconciled on-chain: ${run.reconciledSnapshot.fetchedAt} · ${run.reconciledSnapshot.positions.length} position(s)`,
    );
  }
  if (run.reconciliationError) {
    lines.push(
      `Reconciliation warning: ${truncate(run.reconciliationError, 500)}`,
    );
  }
  const payments = run.payments ?? [];
  if (payments.length > 0) {
    const total = payments.reduce(
      (sum, payment) => sum + BigInt(payment.amountBaseUnits),
      0n,
    );
    lines.push(
      `Canix402 payments: ${payments.length} call(s), ${total.toString()} USDC base units`,
    );
  }
  if (run.error) {
    lines.push(`Error: ${truncate(run.error, 500)}`);
  }

  return truncate(lines.join("\n"), 4_000);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 6,
  }).format(value);
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}
