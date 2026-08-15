import type {
  AccountingRun,
  ExecutionOutcome,
  PortfolioAction,
  ReviewRun,
} from "../domain.js";
import { sanitizeErrorText } from "../util/errors.js";
import { formatInferenceCostLine } from "./inference-cost.js";

const PLAIN_REPORT_LIMIT = 4_000;
const RICH_REPORT_LIMIT = 32_000;
const HTML_REPORT_LIMIT = 4_000;
const MAX_ACTIONS_IN_REPORT = 8;
const ALLO_TX_BASE = "https://allo.info/tx";

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
    try {
      await this.sendRichMessage(formatTelegramReportRich(run));
    } catch {
      try {
        await this.sendHtmlMessage(formatTelegramReportHtml(run));
      } catch {
        await this.sendPlainMessage(formatTelegramReport(run));
      }
    }
  }

  async sendAccounting(run: AccountingRun): Promise<void> {
    try {
      await this.sendRichMessage(formatAccountingTelegramReportRich(run));
    } catch {
      try {
        await this.sendHtmlMessage(formatAccountingTelegramReportHtml(run));
      } catch {
        await this.sendPlainMessage(formatAccountingTelegramReport(run));
      }
    }
  }

  private async sendRichMessage(markdown: string): Promise<void> {
    await this.post("sendRichMessage", {
      rich_message: { markdown },
    });
  }

  private async sendHtmlMessage(html: string): Promise<void> {
    await this.post("sendMessage", {
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  }

  private async sendPlainMessage(text: string): Promise<void> {
    await this.post("sendMessage", {
      text,
      disable_web_page_preview: true,
    });
  }

  private async post(
    method: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const response = await fetch(
      `https://api.telegram.org/bot${this.botToken}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          ...body,
        }),
      },
    );
    const payload = (await response.json()) as {
      ok?: boolean;
      description?: string;
    };
    if (!response.ok || payload.ok === false) {
      throw new Error(
        `Telegram API ${method} failed (HTTP ${response.status})${
          payload.description ? `: ${payload.description}` : ""
        }`,
      );
    }
  }
}

/** Fallback when Telegram is not configured: print the same report text to stdout. */
export class ConsoleNotifier implements RunNotifier, AccountingNotifier {
  send(run: ReviewRun): Promise<void> {
    console.log(formatTelegramReport(run));
    return Promise.resolve();
  }

  sendAccounting(run: AccountingRun): Promise<void> {
    console.log(formatAccountingTelegramReport(run));
    return Promise.resolve();
  }
}

/**
 * Escape dynamic free text so it cannot break Telegram Rich Markdown (GFM-like).
 * Do not use on values already wrapped in backticks or on trusted numeric labels.
 */
export function escapeRichMarkdown(text: string): string {
  return [...text]
    .map((ch) => ("\\`*_[]()#|>~".includes(ch) ? `\\${ch}` : ch))
    .join("");
}

/** Escape dynamic text for Telegram HTML parse_mode. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export interface ReviewExecutionGateSummary {
  /** What happened to on-chain submission. */
  execution: string;
  /** Policy gate result. */
  policy: string;
  /** Signing config at run time. */
  signing: string;
  /** One-line operator explanation. */
  reason: string;
}

/**
 * Explicit operator-facing summary of whether txs were (or could be) submitted.
 * Keeps signing vs policy vs dry-run from collapsing into a vague "planned".
 */
export function describeReviewExecutionGate(
  run: ReviewRun,
): ReviewExecutionGateSummary {
  const signing = run.signingEnabled ? "enabled" : "disabled";

  if (run.error && !run.plan) {
    return {
      execution: "not submitted",
      policy: run.policy
        ? run.policy.approved
          ? "approved"
          : "blocked"
        : "n/a",
      signing,
      reason: "Run failed before submission",
    };
  }

  if (!run.plan) {
    return {
      execution: "not submitted",
      policy: "n/a",
      signing,
      reason: "No structured plan to submit",
    };
  }

  if (!run.policy) {
    return {
      execution: "not submitted",
      policy: "unknown",
      signing,
      reason: "Policy result missing; nothing was signed",
    };
  }

  if (!run.policy.approved) {
    const firstViolation = run.policy.violations[0];
    return {
      execution: "not submitted",
      policy: "blocked",
      signing,
      reason: firstViolation
        ? `Policy blocked — ${truncate(firstViolation, 200)}`
        : "Policy blocked the plan; no transactions were signed",
    };
  }

  if (!run.signingEnabled) {
    return {
      execution: "dry-run only (no txs)",
      policy: "approved",
      signing,
      reason:
        "Policy approved, but signing is disabled — actions were validated only",
    };
  }

  const executions = run.executions ?? [];
  const confirmed = executions.filter(
    (outcome) => outcome.status === "confirmed",
  ).length;
  const failed = executions.filter(
    (outcome) => outcome.status === "failed",
  ).length;
  const actionable = (run.plan.actions ?? []).filter(
    (action) => action.type !== "hold",
  ).length;

  if (confirmed > 0 && failed > 0) {
    return {
      execution: `partially submitted (${confirmed}/${actionable} confirmed)`,
      policy: "approved",
      signing,
      reason: "Signing enabled; some actions confirmed and some failed",
    };
  }
  if (confirmed > 0) {
    return {
      execution: `submitted (${confirmed} confirmed)`,
      policy: "approved",
      signing,
      reason: "Policy approved and signing enabled — transactions submitted",
    };
  }
  if (failed > 0) {
    return {
      execution: "not submitted (execution failed)",
      policy: "approved",
      signing,
      reason: "Signing was enabled but execution failed before confirmation",
    };
  }

  return {
    execution: "not submitted",
    policy: "approved",
    signing,
    reason: "Policy approved and signing enabled, but no actions were executed",
  };
}

export function formatTelegramReport(run: ReviewRun): string {
  const gate = describeReviewExecutionGate(run);
  const heading = `Treasury portfolio run: ${run.status}`;
  const lines = [
    heading,
    `Mode: ${run.mode}`,
    `Signing: ${gate.signing}`,
    `Policy: ${gate.policy}`,
    `Execution: ${gate.execution}`,
    `Why: ${gate.reason}`,
    `Run: ${run.id}`,
    `Completed: ${run.completedAt}`,
  ];

  if (run.error) {
    lines.push(`Error: ${formatReportError(run.error, 500)}`);
  }
  if (run.opportunities.length > 0) {
    lines.push(`Candidates reviewed: ${run.opportunities.length}`);
  }
  if (run.plan) {
    lines.push(
      `Plan confidence: ${formatNumber(run.plan.confidence * 100)}%`,
      `Projected net benefit: $${formatNumber(run.plan.projectedNetBenefitUsd)}`,
      `Summary: ${truncate(run.plan.summary, 700)}`,
    );
  } else if (run.planRawText) {
    if (run.planParseError) {
      lines.push(
        `Structured plan parse note: ${truncate(run.planParseError, 300)}`,
      );
    }
    lines.push(`Agent report: ${truncate(run.planRawText, 1500)}`);
  }
  if (run.policy && !run.policy.approved && run.policy.violations.length > 0) {
    lines.push(
      `Policy blocked: ${truncate(run.policy.violations.join("; "), 750)}`,
    );
  }
  if (run.policy && run.policy.warnings.length > 0) {
    lines.push(
      `Policy notes: ${truncate(run.policy.warnings.join("; "), 750)}`,
    );
  }
  for (const execution of run.executions ?? []) {
    lines.push(
      `Action ${execution.actionId}: ${execution.status}${execution.transactionId ? ` · ${execution.transactionId}` : ""}${execution.error ? ` · ${formatReportError(execution.error, 240)}` : ""}`,
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
  const inferenceLine = formatInferenceCostLine(run.inferenceCost);
  if (inferenceLine) {
    lines.push(inferenceLine);
  }

  return truncate(lines.join("\n"), PLAIN_REPORT_LIMIT);
}

/**
 * Rich Markdown for sendRichMessage.
 * Uses ### headings (not #) so tables parse as blocks while staying closer to body type.
 */
export function formatTelegramReportRich(run: ReviewRun): string {
  const gate = describeReviewExecutionGate(run);
  const sections: string[] = [
    `### Treasury review · ${run.status}`,
    `**Signing** ${gate.signing} · **Policy** ${gate.policy} · **Mode** ${run.mode}`,
    `**Execution** ${gate.execution}`,
    `**Why:** ${escapeRichMarkdown(gate.reason)}`,
    `Run \`${run.id}\` · Completed ${run.completedAt}`,
  ];

  if (run.error) {
    sections.push(
      "",
      `**Error:** ${escapeRichMarkdown(formatReportError(run.error, 500))}`,
    );
  }

  if (run.policy && !run.policy.approved && run.policy.violations.length > 0) {
    sections.push("", "### Policy blocked");
    for (const violation of run.policy.violations.slice(0, 5)) {
      sections.push(`- ${escapeRichMarkdown(truncate(violation, 240))}`);
    }
    if (run.policy.violations.length > 5) {
      sections.push(
        `- _+${run.policy.violations.length - 5} more violation(s)_`,
      );
    }
  }

  if (run.opportunities.length > 0) {
    sections.push(`Candidates reviewed: **${run.opportunities.length}**`);
  }

  if (run.plan) {
    sections.push(
      "",
      "### Plan",
      `Confidence **${formatNumber(run.plan.confidence * 100)}%** · Projected benefit **$${formatNumber(run.plan.projectedNetBenefitUsd)}**`,
      `> ${escapeRichMarkdown(truncate(run.plan.summary, 700))}`,
    );
  } else if (run.planRawText) {
    sections.push("", "### Agent report");
    if (run.planParseError) {
      sections.push(
        `Structured plan parse note: ${escapeRichMarkdown(truncate(run.planParseError, 300))}`,
      );
    }
    sections.push(`> ${escapeRichMarkdown(truncate(run.planRawText, 1500))}`);
  }

  const actionRows = buildActionRows(run);
  if (actionRows.length > 0) {
    sections.push(
      "",
      "### Actions",
      "",
      "| Action | Status | Detail |",
      "| --- | --- | --- |",
    );
    for (const row of actionRows) {
      sections.push(`| ${row.action} | ${row.status} | ${row.detail} |`);
    }
    const totalActions = run.plan?.actions.length ?? 0;
    if (totalActions > MAX_ACTIONS_IN_REPORT) {
      sections.push(
        "",
        `_+${totalActions - MAX_ACTIONS_IN_REPORT} more action(s)_`,
      );
    }
  }

  const riskPolicyBody = buildRiskPolicyDetailsBody(run);
  if (riskPolicyBody) {
    sections.push(
      "",
      "<details>",
      "<summary>Risks / policy notes</summary>",
      "",
      riskPolicyBody,
      "",
      "</details>",
    );
  }

  if (run.reconciledSnapshot) {
    sections.push(
      "",
      `Reconciled on-chain: ${run.reconciledSnapshot.fetchedAt} · **${run.reconciledSnapshot.positions.length}** position(s)`,
    );
  }
  if (run.reconciliationError) {
    sections.push(
      `**Reconciliation warning:** ${escapeRichMarkdown(truncate(run.reconciliationError, 500))}`,
    );
  }

  const spendLines = buildSpendLines(run);
  if (spendLines.length > 0) {
    sections.push("", "### Spend", "", ...spendLines);
  }

  return truncate(sections.join("\n"), RICH_REPORT_LIMIT);
}

/** HTML fallback for classic sendMessage parse_mode=HTML. */
export function formatTelegramReportHtml(run: ReviewRun): string {
  const gate = describeReviewExecutionGate(run);
  const sections: string[] = [
    `<b>Treasury review · ${escapeHtml(run.status)}</b>`,
    `<b>Signing</b> ${escapeHtml(gate.signing)} · <b>Policy</b> ${escapeHtml(gate.policy)} · <b>Mode</b> ${escapeHtml(run.mode)}`,
    `<b>Execution</b> ${escapeHtml(gate.execution)}`,
    `<b>Why:</b> ${escapeHtml(gate.reason)}`,
    `Run <code>${escapeHtml(run.id)}</code> · Completed ${escapeHtml(run.completedAt)}`,
  ];

  if (run.error) {
    sections.push(
      "",
      `<b>Error:</b> ${escapeHtml(formatReportError(run.error, 500))}`,
    );
  }
  if (run.policy && !run.policy.approved && run.policy.violations.length > 0) {
    sections.push("", "<b>Policy blocked</b>");
    for (const violation of run.policy.violations.slice(0, 5)) {
      sections.push(`• ${escapeHtml(truncate(violation, 240))}`);
    }
  }
  if (run.opportunities.length > 0) {
    sections.push(`Candidates reviewed: <b>${run.opportunities.length}</b>`);
  }
  if (run.plan) {
    sections.push(
      "",
      "<b>Plan</b>",
      `Confidence <b>${escapeHtml(formatNumber(run.plan.confidence * 100))}%</b> · Projected benefit <b>$${escapeHtml(formatNumber(run.plan.projectedNetBenefitUsd))}</b>`,
      `<blockquote>${escapeHtml(truncate(run.plan.summary, 700))}</blockquote>`,
    );
  } else if (run.planRawText) {
    sections.push("", "<b>Agent report</b>");
    if (run.planParseError) {
      sections.push(
        `Structured plan parse note: ${escapeHtml(truncate(run.planParseError, 300))}`,
      );
    }
    sections.push(
      `<blockquote>${escapeHtml(truncate(run.planRawText, 1500))}</blockquote>`,
    );
  }

  const actionLines = buildActionHtmlLines(run);
  if (actionLines.length > 0) {
    sections.push("", "<b>Actions</b>", ...actionLines);
  }

  const riskPolicyLines = buildRiskPolicyHtmlLines(run);
  if (riskPolicyLines.length > 0) {
    sections.push("", "<b>Risks / policy notes</b>", ...riskPolicyLines);
  }

  const spendLines = buildSpendHtmlLines(run);
  if (spendLines.length > 0) {
    sections.push("", "<b>Spend</b>", ...spendLines);
  }

  return truncate(sections.join("\n"), HTML_REPORT_LIMIT);
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
      ...formatAccountingPnlPlainLines(run.summary),
    );
    if (run.summary.unpricedAssetIds.length > 0) {
      lines.push(`Unpriced ASAs: ${run.summary.unpricedAssetIds.join(", ")}`);
    }
    const reportNotes = filterAccountingNotes(run.summary.notes);
    if (reportNotes.length > 0) {
      lines.push(`Notes: ${truncate(reportNotes.join("; "), 700)}`);
    }
  }
  if (run.snapshotKey) {
    lines.push(`Snapshot: ${run.snapshotKey}`);
  }
  if (run.error) {
    lines.push(`Error: ${formatReportError(run.error, 500)}`);
  }
  if (run.notificationError) {
    lines.push(`Notification warning: ${truncate(run.notificationError, 240)}`);
  }

  return truncate(lines.join("\n"), PLAIN_REPORT_LIMIT);
}

export function formatAccountingTelegramReportRich(run: AccountingRun): string {
  const sections: string[] = [
    `### Treasury accounting · ${run.status}`,
    `Run \`${run.id}\` · Completed ${run.completedAt}`,
  ];

  if (run.error) {
    sections.push(
      "",
      `**Error:** ${escapeRichMarkdown(formatReportError(run.error, 500))}`,
    );
  }

  if (run.summary) {
    sections.push("", "### DeFi by protocol", "");
    if (run.summary.defiByProtocol.length === 0) {
      sections.push("_none_");
    } else {
      sections.push(
        "| Protocol | Value | Positions |",
        "| --- | ---: | ---: |",
      );
      for (const entry of run.summary.defiByProtocol) {
        sections.push(
          `| ${escapeRichMarkdown(entry.protocol)} | ${formatMoneyLabel(entry.valueUsd)} | ${entry.positionCount} |`,
        );
      }
    }

    sections.push(
      "",
      "### Wallet",
      "",
      `ASA total **${formatMoneyLabel(run.summary.walletAsaValueUsd)}** · ALGO **${run.summary.algoBalance}** · Min balance **${run.summary.minimumBalance}**`,
      ...formatAccountingPnlRichLines(run.summary),
    );

    const detailsBody = buildAccountingDetailsBody(run);
    if (detailsBody) {
      sections.push(
        "",
        "<details>",
        "<summary>Notes</summary>",
        "",
        detailsBody,
        "",
        "</details>",
      );
    }
  }

  if (run.snapshotKey) {
    sections.push("", `Snapshot: \`${run.snapshotKey}\``);
  }
  if (run.notificationError) {
    sections.push(
      `**Notification warning:** ${escapeRichMarkdown(truncate(run.notificationError, 240))}`,
    );
  }

  return truncate(sections.join("\n"), RICH_REPORT_LIMIT);
}

export function formatAccountingTelegramReportHtml(run: AccountingRun): string {
  const sections: string[] = [
    `<b>Treasury accounting · ${escapeHtml(run.status)}</b>`,
    `Run <code>${escapeHtml(run.id)}</code> · Completed ${escapeHtml(run.completedAt)}`,
  ];

  if (run.error) {
    sections.push(
      "",
      `<b>Error:</b> ${escapeHtml(formatReportError(run.error, 500))}`,
    );
  }

  if (run.summary) {
    sections.push("", "<b>DeFi by protocol</b>");
    if (run.summary.defiByProtocol.length === 0) {
      sections.push("<i>none</i>");
    } else {
      for (const entry of run.summary.defiByProtocol) {
        sections.push(
          `• <b>${escapeHtml(entry.protocol)}</b>: ${escapeHtml(formatMoneyLabel(entry.valueUsd))} (${entry.positionCount})`,
        );
      }
    }

    sections.push(
      "",
      "<b>Wallet</b>",
      `ASA total <b>${escapeHtml(formatMoneyLabel(run.summary.walletAsaValueUsd))}</b> · ALGO <b>${escapeHtml(run.summary.algoBalance)}</b> · Min balance <b>${escapeHtml(run.summary.minimumBalance)}</b>`,
      ...formatAccountingPnlHtmlLines(run.summary),
    );

    const noteLines = buildAccountingNoteHtmlLines(run);
    if (noteLines.length > 0) {
      sections.push("", "<b>Notes</b>", ...noteLines);
    }
  }

  if (run.snapshotKey) {
    sections.push("", `Snapshot: <code>${escapeHtml(run.snapshotKey)}</code>`);
  }

  return truncate(sections.join("\n"), HTML_REPORT_LIMIT);
}

function buildActionRows(
  run: ReviewRun,
): Array<{ action: string; status: string; detail: string }> {
  const executionsById = new Map(
    (run.executions ?? []).map((execution) => [execution.actionId, execution]),
  );
  const planActions = run.plan?.actions ?? [];
  const notExecuted = describeNotExecutedAction(run);

  if (planActions.length > 0) {
    return planActions.slice(0, MAX_ACTIONS_IN_REPORT).map((action) => {
      const execution = executionsById.get(action.id);
      return {
        action: escapeRichMarkdown(formatPlanActionLabel(action)),
        status: escapeRichMarkdown(execution?.status ?? notExecuted.status),
        detail: execution
          ? formatActionDetailMarkdown(execution)
          : escapeRichMarkdown(notExecuted.detail),
      };
    });
  }

  return (run.executions ?? [])
    .slice(0, MAX_ACTIONS_IN_REPORT)
    .map((execution) => ({
      action: escapeRichMarkdown(execution.actionId),
      status: escapeRichMarkdown(execution.status),
      detail: formatActionDetailMarkdown(execution),
    }));
}

function describeNotExecutedAction(run: ReviewRun): {
  status: string;
  detail: string;
} {
  if (run.policy && !run.policy.approved) {
    return { status: "not executed", detail: "policy blocked" };
  }
  if (!run.signingEnabled) {
    return { status: "not executed", detail: "signing disabled" };
  }
  return { status: "not executed", detail: "no execution outcome" };
}

function formatPlanActionLabel(action: PortfolioAction): string {
  const protocol = action.protocol ? ` · ${action.protocol}` : "";
  const rationale = truncate(action.rationale, 80);
  return `${action.type}${protocol} · ${rationale}`;
}

function formatActionDetailMarkdown(
  execution: ExecutionOutcome | undefined,
): string {
  if (!execution) {
    return "—";
  }
  if (execution.transactionId) {
    const url = `${ALLO_TX_BASE}/${execution.transactionId}`;
    const label = escapeRichMarkdown(truncate(execution.transactionId, 16));
    return `[${label}](${url})`;
  }
  if (execution.error) {
    return escapeRichMarkdown(formatReportError(execution.error, 120));
  }
  return "—";
}

function buildRiskPolicyDetailsBody(run: ReviewRun): string | undefined {
  const lines: string[] = [];
  for (const risk of run.plan?.risks ?? []) {
    lines.push(`- ${escapeRichMarkdown(truncate(risk, 240))}`);
  }
  // Violations are shown above the fold when blocked; keep them here too for
  // the collapsed notes section when there are also risks/warnings.
  if (
    run.policy &&
    !run.policy.approved &&
    run.policy.violations.length > 0 &&
    (run.plan?.risks?.length ?? 0) + (run.policy.warnings.length ?? 0) > 0
  ) {
    for (const violation of run.policy.violations) {
      lines.push(
        `- **Blocked:** ${escapeRichMarkdown(truncate(violation, 240))}`,
      );
    }
  }
  if (run.policy && run.policy.warnings.length > 0) {
    for (const warning of run.policy.warnings) {
      lines.push(`- ${escapeRichMarkdown(truncate(warning, 240))}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function buildSpendLines(run: ReviewRun): string[] {
  const lines: string[] = [];
  const payments = run.payments ?? [];
  if (payments.length > 0) {
    const total = payments.reduce(
      (sum, payment) => sum + BigInt(payment.amountBaseUnits),
      0n,
    );
    lines.push(
      `Canix402: **${payments.length}** call(s), \`${total.toString()}\` USDC base units`,
    );
  }
  const inferenceLine = formatInferenceCostLine(run.inferenceCost);
  if (inferenceLine) {
    lines.push(escapeRichMarkdown(inferenceLine));
  }
  return lines;
}

function buildAccountingDetailsBody(run: AccountingRun): string | undefined {
  if (!run.summary) {
    return undefined;
  }
  const lines: string[] = [];
  if (run.summary.unpricedAssetIds.length > 0) {
    lines.push(`- Unpriced ASAs: ${run.summary.unpricedAssetIds.join(", ")}`);
  }
  for (const note of filterAccountingNotes(run.summary.notes)) {
    lines.push(`- ${escapeRichMarkdown(truncate(note, 240))}`);
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function buildActionHtmlLines(run: ReviewRun): string[] {
  const executionsById = new Map(
    (run.executions ?? []).map((execution) => [execution.actionId, execution]),
  );
  const planActions = run.plan?.actions ?? [];
  const notExecuted = describeNotExecutedAction(run);

  if (planActions.length > 0) {
    return planActions.slice(0, MAX_ACTIONS_IN_REPORT).map((action) => {
      const execution = executionsById.get(action.id);
      const status = escapeHtml(execution?.status ?? notExecuted.status);
      const detail = execution
        ? formatActionDetailHtml(execution)
        : escapeHtml(notExecuted.detail);
      return `• ${escapeHtml(formatPlanActionLabel(action))} — <i>${status}</i>${detail ? ` · ${detail}` : ""}`;
    });
  }

  return (run.executions ?? [])
    .slice(0, MAX_ACTIONS_IN_REPORT)
    .map((execution) => {
      const detail = formatActionDetailHtml(execution);
      return `• <code>${escapeHtml(execution.actionId)}</code> — <i>${escapeHtml(execution.status)}</i>${detail ? ` · ${detail}` : ""}`;
    });
}

function formatActionDetailHtml(
  execution: ExecutionOutcome | undefined,
): string {
  if (!execution) {
    return "";
  }
  if (execution.transactionId) {
    const url = `${ALLO_TX_BASE}/${execution.transactionId}`;
    const label = escapeHtml(truncate(execution.transactionId, 16));
    return `<a href="${url}">${label}</a>`;
  }
  if (execution.error) {
    return escapeHtml(formatReportError(execution.error, 120));
  }
  return "";
}

function buildRiskPolicyHtmlLines(run: ReviewRun): string[] {
  const lines: string[] = [];
  for (const risk of run.plan?.risks ?? []) {
    lines.push(`• ${escapeHtml(truncate(risk, 240))}`);
  }
  if (
    run.policy &&
    !run.policy.approved &&
    run.policy.violations.length > 0 &&
    (run.plan?.risks?.length ?? 0) + (run.policy.warnings.length ?? 0) > 0
  ) {
    for (const violation of run.policy.violations) {
      lines.push(`• <b>Blocked:</b> ${escapeHtml(truncate(violation, 240))}`);
    }
  }
  if (run.policy && run.policy.warnings.length > 0) {
    for (const warning of run.policy.warnings) {
      lines.push(`• ${escapeHtml(truncate(warning, 240))}`);
    }
  }
  return lines;
}

function buildSpendHtmlLines(run: ReviewRun): string[] {
  const lines: string[] = [];
  const payments = run.payments ?? [];
  if (payments.length > 0) {
    const total = payments.reduce(
      (sum, payment) => sum + BigInt(payment.amountBaseUnits),
      0n,
    );
    lines.push(
      `Canix402: <b>${payments.length}</b> call(s), <code>${total.toString()}</code> USDC base units`,
    );
  }
  const inferenceLine = formatInferenceCostLine(run.inferenceCost);
  if (inferenceLine) {
    lines.push(escapeHtml(inferenceLine));
  }
  return lines;
}

function buildAccountingNoteHtmlLines(run: AccountingRun): string[] {
  if (!run.summary) {
    return [];
  }
  const lines: string[] = [];
  if (run.summary.unpricedAssetIds.length > 0) {
    lines.push(
      `• Unpriced ASAs: ${escapeHtml(run.summary.unpricedAssetIds.join(", "))}`,
    );
  }
  for (const note of filterAccountingNotes(run.summary.notes)) {
    lines.push(`• ${escapeHtml(truncate(note, 240))}`);
  }
  return lines;
}

function filterAccountingNotes(notes: string[]): string[] {
  return notes.filter(
    (note) =>
      note !== "No previous accounting baseline; P&L not available yet" &&
      note !== "No DeFi positions" &&
      !note.startsWith("P&L adjusted for "),
  );
}

function formatAccountingPnlPlainLines(
  summary: NonNullable<AccountingRun["summary"]>,
): string[] {
  const lines = [
    summary.pnlAvailable
      ? `P&L vs previous: ${formatMoneyLabel(summary.pnlUsd)}`
      : "P&L vs previous: no previous baseline",
    ...formatWindowPnlPlainLines(summary),
  ];
  const funding = formatNetExternalFundingLabel(summary.netExternalCashflowUsd);
  if (funding) {
    lines.push(`External funding (window): ${funding}`);
  }
  return lines;
}

function formatWindowPnlPlainLines(
  summary: NonNullable<AccountingRun["summary"]>,
): string[] {
  if (!summary.windows) {
    return [];
  }
  return (["7d", "30d", "all"] as const).map((id) => {
    const window = summary.windows![id];
    return window.available
      ? `P&L ${id}: ${formatMoneyLabel(window.pnlUsd)}`
      : `P&L ${id}: n/a${window.reason ? ` (${window.reason})` : ""}`;
  });
}

function formatAccountingPnlRichLines(
  summary: NonNullable<AccountingRun["summary"]>,
): string[] {
  const lines = [
    summary.pnlAvailable
      ? `P&L vs previous: **${formatMoneyLabel(summary.pnlUsd)}**`
      : "P&L vs previous: _no previous baseline_",
    ...formatWindowPnlRichLines(summary),
  ];
  const funding = formatNetExternalFundingLabel(summary.netExternalCashflowUsd);
  if (funding) {
    lines.push(`External funding (window): **${funding}**`);
  }
  return lines;
}

function formatWindowPnlRichLines(
  summary: NonNullable<AccountingRun["summary"]>,
): string[] {
  if (!summary.windows) {
    return [];
  }
  return (["7d", "30d", "all"] as const).map((id) => {
    const window = summary.windows![id];
    return window.available
      ? `P&L ${id}: **${formatMoneyLabel(window.pnlUsd)}**`
      : `P&L ${id}: _n/a_`;
  });
}

function formatAccountingPnlHtmlLines(
  summary: NonNullable<AccountingRun["summary"]>,
): string[] {
  const lines = [
    summary.pnlAvailable
      ? `P&amp;L vs previous: <b>${escapeHtml(formatMoneyLabel(summary.pnlUsd))}</b>`
      : "P&amp;L vs previous: <i>no previous baseline</i>",
    ...formatWindowPnlHtmlLines(summary),
  ];
  const funding = formatNetExternalFundingLabel(summary.netExternalCashflowUsd);
  if (funding) {
    lines.push(`External funding (window): <b>${escapeHtml(funding)}</b>`);
  }
  return lines;
}

function formatWindowPnlHtmlLines(
  summary: NonNullable<AccountingRun["summary"]>,
): string[] {
  if (!summary.windows) {
    return [];
  }
  return (["7d", "30d", "all"] as const).map((id) => {
    const window = summary.windows![id];
    return window.available
      ? `P&amp;L ${id}: <b>${escapeHtml(formatMoneyLabel(window.pnlUsd))}</b>`
      : `P&amp;L ${id}: <i>n/a</i>`;
  });
}

/** Net capital in: deposits − withdrawals. Null/zero omitted from reports. */
function formatNetExternalFundingLabel(
  value: string | null | undefined,
): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) {
    return undefined;
  }
  return formatMoneyLabel(value);
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

function formatReportError(value: string, length: number): string {
  return sanitizeErrorText(value, { maxLength: length });
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}
