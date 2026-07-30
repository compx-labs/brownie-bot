import { readFile } from "node:fs/promises";

import {
  GetObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

/** Convention path when DigitalOcean Spaces is not configured. */
export const LOCAL_OPERATOR_PREFERENCES_PATH = "config/operator-preferences.md";

/** Object name under DO_SPACES_PREFIX. */
export const OPERATOR_PREFERENCES_OBJECT_NAME = "operator-preferences.md";

export interface SpacesOperatorPreferencesOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
  client?: S3Client;
}

export interface LoadOperatorPreferencesOptions {
  /** When set, load from Spaces; otherwise try the local convention path. */
  spaces?: SpacesOperatorPreferencesOptions;
  /** Override local path (tests). Defaults to config/operator-preferences.md. */
  localPath?: string;
}

/**
 * Load optional operator strategy markdown by convention.
 * Spaces (when configured) wins; otherwise local file. Missing → undefined.
 * Load/network errors warn and return undefined (do not fail the review).
 */
export async function loadOperatorPreferences(
  options: LoadOperatorPreferencesOptions = {},
): Promise<string | undefined> {
  try {
    if (options.spaces) {
      return await loadFromSpaces(options.spaces);
    }
    return await loadFromLocal(
      options.localPath ?? LOCAL_OPERATOR_PREFERENCES_PATH,
    );
  } catch (error) {
    console.warn(
      `[operator-preferences] Failed to load preferences; continuing without them: ${errorMessage(error)}`,
    );
    return undefined;
  }
}

async function loadFromSpaces(
  options: SpacesOperatorPreferencesOptions,
): Promise<string | undefined> {
  const prefix = trimSlashes(options.prefix ?? "");
  const key = joinKey(prefix, OPERATOR_PREFERENCES_OBJECT_NAME);
  const client =
    options.client ??
    new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: false,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    } satisfies S3ClientConfig);

  try {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: options.bucket,
        Key: key,
      }),
    );
    const text = await response.Body?.transformToString();
    const trimmed = text?.trim();
    if (!trimmed) {
      console.info(
        `[operator-preferences] Spaces object ${key} missing or empty; disregarding`,
      );
      return undefined;
    }
    console.info(
      `[operator-preferences] Loaded operator preferences from Spaces (${key})`,
    );
    return trimmed;
  } catch (error) {
    if (isS3NotFound(error)) {
      console.info(
        `[operator-preferences] Spaces object ${key} not found; disregarding`,
      );
      return undefined;
    }
    throw error;
  }
}

async function loadFromLocal(path: string): Promise<string | undefined> {
  try {
    const text = await readFile(path, "utf8");
    const trimmed = text.trim();
    if (!trimmed) {
      console.info(
        `[operator-preferences] Local file ${path} empty; disregarding`,
      );
      return undefined;
    }
    console.info(
      `[operator-preferences] Loaded operator preferences from ${path}`,
    );
    return trimmed;
  } catch (error) {
    if (isErrnoNotFound(error)) {
      console.info(
        `[operator-preferences] Local file ${path} not found; disregarding`,
      );
      return undefined;
    }
    throw error;
  }
}

function joinKey(...parts: string[]): string {
  return parts
    .map(trimSlashes)
    .filter((part) => part.length > 0)
    .join("/");
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function isErrnoNotFound(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT",
  );
}

function isS3NotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as Record<string, unknown>;
  return (
    record.name === "NoSuchKey" ||
    record.Code === "NoSuchKey" ||
    (record.$metadata !== undefined &&
      typeof record.$metadata === "object" &&
      (record.$metadata as { httpStatusCode?: number }).httpStatusCode === 404)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
