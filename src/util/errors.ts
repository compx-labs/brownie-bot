const DEFAULT_MAX_LENGTH = 280;

/**
 * Turn opaque upstream failures (esp. OpenAI/ZeroSignal CDN HTML 502/504 pages)
 * into short operator-facing messages for Telegram, persisted runs, and logs.
 */
export function sanitizeErrorMessage(
  error: unknown,
  options?: { maxLength?: number },
): string {
  const maxLength = options?.maxLength ?? DEFAULT_MAX_LENGTH;
  if (error instanceof Error) {
    const status = readNumericStatus(error);
    const raw = error.message.trim() || error.name;
    if (!raw || raw === "Error") {
      return "Unknown error";
    }
    return sanitizeErrorText(raw, {
      maxLength,
      status,
    });
  }
  if (typeof error === "string") {
    return sanitizeErrorText(error, { maxLength });
  }
  return "Unknown error";
}

export function sanitizeErrorText(
  text: string,
  options?: { maxLength?: number; status?: number },
): string {
  const maxLength = options?.maxLength ?? DEFAULT_MAX_LENGTH;
  const trimmed = text.trim();
  if (!trimmed) {
    return "Unknown error";
  }

  const status =
    options?.status ??
    parseLeadingHttpStatus(trimmed) ??
    parseEmbeddedHttpStatus(trimmed);
  const body = stripLeadingHttpStatus(trimmed);
  const classified = classifyHtmlOrGatewayFailure(status, body, trimmed);
  const source = classified ?? collapseWhitespace(trimmed);
  return truncateMessage(source || "Unknown error", maxLength);
}

function readNumericStatus(error: Error): number | undefined {
  const status = (error as Error & { status?: unknown }).status;
  return typeof status === "number" && Number.isFinite(status)
    ? status
    : undefined;
}

function parseLeadingHttpStatus(text: string): number | undefined {
  const match = /^(\d{3})\b/.exec(text);
  if (!match) {
    return undefined;
  }
  const status = Number(match[1]);
  return status >= 100 && status <= 599 ? status : undefined;
}

function stripLeadingHttpStatus(text: string): string {
  return text.replace(/^\d{3}\b\s*/, "").trim();
}

/** Prefer status codes that sit immediately before an HTML body. */
function parseEmbeddedHttpStatus(text: string): number | undefined {
  const beforeHtml = /\b([45]\d{2})\b(?=\s*<)/.exec(text);
  if (beforeHtml) {
    return Number(beforeHtml[1]);
  }
  const titled = /\b(?:ERROR|HTTP)\s+([45]\d{2})\b/i.exec(text);
  if (titled) {
    return Number(titled[1]);
  }
  return undefined;
}

function classifyHtmlOrGatewayFailure(
  status: number | undefined,
  body: string,
  fullText: string,
): string | null {
  const htmlCandidate = body || fullText;
  const isHtml = looksLikeHtml(htmlCandidate);
  const gatewayPhrase =
    extractGatewayPhrase(htmlCandidate) ?? extractGatewayPhrase(fullText);
  if (!isHtml && !gatewayPhrase && status === undefined) {
    return null;
  }
  if (!isHtml && !gatewayPhrase) {
    // Status-only noise without useful body — keep original unless body is huge junk.
    if (!status || body.length < 120) {
      return null;
    }
    if (!looksLikeNoiseBody(body)) {
      return null;
    }
  }

  const origin = extractOriginHost(htmlCandidate);
  const reason =
    gatewayPhrase ??
    (status === 504
      ? "gateway timeout"
      : status === 502
        ? "bad gateway"
        : status === 503
          ? "service unavailable"
          : status
            ? `HTTP ${status}`
            : "upstream error");

  const provider = resolveProvider(fullText, origin);
  const parts = [`${provider} ${reason}`];
  if (status) {
    parts[0] = `${parts[0]} (${status})`;
  }
  if (origin) {
    parts.push(`could not reach ${origin}`);
  }
  return parts.join("; ");
}

function resolveProvider(text: string, origin: string | null): string {
  if (
    origin?.endsWith(".belt.algo.xyz") ||
    /\bzerosignal\b|\bzs-proxy\b|\/v1\/responses\b/i.test(text) // pragma: allowlist secret
  ) {
    return "ZeroSignal";
  }
  if (/\bcanix\b|\bcanix402\b|PAYMENT_REQUIRED/i.test(text)) {
    return "Canix";
  }
  return "Upstream";
}

function looksLikeHtml(text: string): boolean {
  return /<!DOCTYPE\s+html\b/i.test(text) || /<\s*html\b/i.test(text);
}

function looksLikeNoiseBody(text: string): boolean {
  return (
    looksLikeHtml(text) ||
    /bunny\.net|bunnynetassets|cdn\.statuspage\.io/i.test(text) ||
    text.includes("<div") ||
    text.includes("<head")
  );
}

function extractGatewayPhrase(text: string): string | null {
  if (/gateway\s+timeout/i.test(text)) {
    return "gateway timeout";
  }
  if (/bad\s+gateway/i.test(text)) {
    return "bad gateway";
  }
  if (/service\s+unavailable/i.test(text)) {
    return "service unavailable";
  }
  return null;
}

function extractOriginHost(text: string): string | null {
  const connection = /connection to\s+([a-z0-9.-]+\.[a-z]{2,})/i.exec(text);
  if (connection?.[1]) {
    return connection[1].toLowerCase();
  }
  const waiting = /waiting for\s+([a-z0-9.-]+\.[a-z]{2,})\s+origin/i.exec(text);
  if (waiting?.[1]) {
    return waiting[1].toLowerCase();
  }
  const belt = /\b([a-z0-9-]+\.belt\.algo\.xyz)\b/i.exec(text);
  if (belt?.[1]) {
    return belt[1].toLowerCase();
  }
  return null;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateMessage(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}
