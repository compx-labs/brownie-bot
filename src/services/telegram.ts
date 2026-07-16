import type { AccountingRun, ReviewRun } from "../domain.js";

export interface RunNotifier {
  send(run: ReviewRun): Promise<void>;
}

export interface AccountingNotifier {
  sendAccounting(run: AccountingRun): Promise<void>;
}

export class TelegramNotifier implements RunNotifier, AccountingNotifier {
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
  ) {}

  async send(run: ReviewRun): Promise<void> {
    await this.sendMessage(formatTelegramReport(run));
  }

  async sendAccounting(run: AccountingRun): Promise<void> {
    await this.sendMessage(formatAccountingTelegramReport(run));
  }

  private async sendMessage(text: string): Promise<void> {
    const response = await fetch(
      `https://api.telegram.org/bot${this.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
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

export function formatAccountingTelegramReport(run: AccountingRun): string {
  const lines = [
    `Treasury accounting run: ${run.status}`,
    `Run: ${run.id}`,
    `Completed: ${run.completedAt}`,
  ];

  if (run.summary) {
    lines.push("DeFi positions:");
    if (run.summary.defiByProtocol.length === 0) {
      lines.push("  none");
    } else {
      for (const entry of run.summary.defiByProtocol) {
        lines.push(
          `  ${entry.protocol}: ${formatMoneyLabel(entry.valueUsd)} (${entry.positionCount})`,
        );
      }
    }
    lines.push(
      `Wallet tokens total: ${formatMoneyLabel(run.summary.walletAsaValueUsd)}`,
      `ALGO balance: ${run.summary.algoBalance}`,
      `Account min balance: ${run.summary.minimumBalance}`,
      run.summary.pnlAvailable
        ? `P&L vs previous: ${formatMoneyLabel(run.summary.pnlUsd)}`
        : "P&L vs previous: no previous baseline",
    );
    if (run.summary.unpricedAssetIds.length > 0) {
      lines.push(`Unpriced ASAs: ${run.summary.unpricedAssetIds.join(", ")}`);
    }
    const reportNotes = run.summary.notes.filter(
      (note) =>
        note !== "No previous accounting baseline; P&L not available yet" &&
        note !== "No DeFi positions",
    );
    if (reportNotes.length > 0) {
      lines.push(`Notes: ${truncate(reportNotes.join("; "), 700)}`);
    }
  }
  if (run.snapshotKey) {
    lines.push(`Snapshot: ${run.snapshotKey}`);
  }
  if (run.error) {
    lines.push(`Error: ${truncate(run.error, 500)}`);
  }
  if (run.notificationError) {
    lines.push(`Notification warning: ${truncate(run.notificationError, 240)}`);
  }

  return truncate(lines.join("\n"), 4_000);
}

function formatMoneyLabel(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return "n/a";
  }
  return `$${value}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 6,
  }).format(value);
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}
