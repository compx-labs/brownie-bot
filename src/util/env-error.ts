import { z } from "zod";

/** Operator docs for env keys. Keep in sync with README heading anchors. */
export const ENV_DOCS_POINTER =
  ".env.example and README.md#environment-variables";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type ZodIssue = z.ZodError["issues"][number];

function envKeyFromIssue(issue: ZodIssue): string | undefined {
  const first = issue.path[0];
  return typeof first === "string" ? first : undefined;
}

function receivedValue(issue: ZodIssue): string | undefined {
  if ("received" in issue && typeof issue.received === "string") {
    return issue.received;
  }
  const match = /received (\S+)$/i.exec(issue.message);
  return match?.[1];
}

function isMissingValueIssue(issue: ZodIssue): boolean {
  if (issue.code === "too_small") {
    // Empty strings (`min(1)`) are missing. Numeric bounds and longer
    // min-length constraints (e.g. MANUAL_TRIGGER_TOKEN min 16) are invalid.
    return issue.origin === "string" && issue.minimum === 1;
  }
  if (issue.code === "invalid_type") {
    const received = receivedValue(issue);
    return (
      received === "undefined" || issue.message.includes("received undefined")
    );
  }
  return false;
}

function invalidDetail(issue: ZodIssue): string | undefined {
  switch (issue.code) {
    case "invalid_format":
      return "format" in issue && issue.format === "url"
        ? "expected a URL"
        : issue.message;
    case "invalid_value": {
      if ("values" in issue && Array.isArray(issue.values)) {
        return `expected one of: ${issue.values.map(String).join(", ")}`;
      }
      return issue.message;
    }
    case "invalid_type": {
      const expected = "expected" in issue ? String(issue.expected) : undefined;
      return expected ? `expected ${expected}` : issue.message;
    }
    case "too_small":
    case "too_big":
      return issue.message.replace(/^Too (?:small|big): /i, "");
    default:
      return issue.message;
  }
}

function describeOtherIssue(
  issue: ZodIssue,
  requiredKeys: ReadonlySet<string>,
): string {
  if (issue.code === "custom") {
    return issue.message;
  }
  const key = envKeyFromIssue(issue);
  if (!key) {
    return issue.message;
  }
  const role = requiredKeys.has(key) ? "Required" : "Optional";
  if (isMissingValueIssue(issue)) {
    return requiredKeys.has(key)
      ? `Missing required env ${key}`
      : `Optional env ${key} is missing`;
  }
  const detail = invalidDetail(issue);
  return detail
    ? `${role} env ${key} is invalid (${detail})`
    : `${role} env ${key} is invalid`;
}

function formatMissingRequired(keys: string[]): string {
  if (keys.length === 1) {
    return `Missing required env ${keys[0]}`;
  }
  const last = keys[keys.length - 1];
  return `Missing required env ${keys.slice(0, -1).join(", ")} and ${last}`;
}

/**
 * Collapse a Zod env-schema failure into one operator-facing line.
 * Names the key, says required vs optional, and points at the docs.
 */
export function formatEnvZodError(
  error: z.ZodError,
  requiredKeys: readonly string[],
): string {
  const required = new Set(requiredKeys);
  const missingRequired: string[] = [];
  const others: string[] = [];

  for (const issue of error.issues) {
    const key = envKeyFromIssue(issue);
    if (key && required.has(key) && isMissingValueIssue(issue)) {
      if (!missingRequired.includes(key)) {
        missingRequired.push(key);
      }
      continue;
    }
    others.push(describeOtherIssue(issue, required));
  }

  const parts: string[] = [];
  if (missingRequired.length > 0) {
    parts.push(formatMissingRequired(missingRequired));
  }
  parts.push(...others);

  const body = (parts.join("; ") || "Invalid environment configuration")
    .replace(/\s+/g, " ")
    .trim();
  if (body.includes(ENV_DOCS_POINTER)) {
    return body.endsWith(".") ? body : `${body}.`;
  }
  return `${body}. See ${ENV_DOCS_POINTER}.`;
}

export function parseEnv<T>(
  schema: z.ZodType<T>,
  environment: NodeJS.ProcessEnv,
  requiredKeys: readonly string[],
): T {
  const parsed = schema.safeParse(environment);
  if (!parsed.success) {
    throw new ConfigError(formatEnvZodError(parsed.error, requiredKeys));
  }
  return parsed.data;
}
