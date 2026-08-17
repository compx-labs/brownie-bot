import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadOperatorPreferences } from "../src/integrations/storage/operator-preferences.js";
import {
  buildPortfolioAgentInstructions,
  PORTFOLIO_AGENT_PROMPT_LITE,
  PORTFOLIO_AGENT_PROMPT_V1,
} from "../src/services/portfolio-agent.js";

describe("portfolio agent base prompt", () => {
  it("describes preferred holds as economic exposure with lend/borrow paths", () => {
    for (const prompt of [
      PORTFOLIO_AGENT_PROMPT_V1,
      PORTFOLIO_AGENT_PROMPT_LITE,
    ]) {
      expect(prompt).toMatch(/economic exposure/i);
      expect(prompt).toMatch(/Lending and borrowing are first-class/i);
      expect(prompt).toMatch(/LP\/farm\/lend/i);
    }
  });

  it("describes claim desk, debt repay, and preferred-hold host search", () => {
    for (const prompt of [
      PORTFOLIO_AGENT_PROMPT_V1,
      PORTFOLIO_AGENT_PROMPT_LITE,
    ]) {
      expect(prompt).toMatch(/claim desk/i);
      expect(prompt).toMatch(/worthClaiming/);
      expect(prompt).toMatch(/positionType "debt"/);
      expect(prompt).toMatch(/preferred-hold/);
    }
  });

  it("has no CompX ASA / core CompX mandate strings", () => {
    for (const prompt of [
      PORTFOLIO_AGENT_PROMPT_V1,
      PORTFOLIO_AGENT_PROMPT_LITE,
    ]) {
      expect(prompt).not.toMatch(/1732165149/);
      expect(prompt).not.toMatch(/core mandate is to build CompX/i);
      expect(prompt).not.toMatch(/For CompX \(ASA/);
    }
  });

  it("appends OPERATOR PREFERENCES when body is non-empty", () => {
    const withPrefs = buildPortfolioAgentInstructions(
      "full",
      " Prefer CompX liquidity.\n",
    );
    expect(withPrefs).toContain("OPERATOR PREFERENCES");
    expect(withPrefs).toContain("Prefer CompX liquidity.");
    expect(withPrefs.startsWith(PORTFOLIO_AGENT_PROMPT_V1)).toBe(true);
  });

  it("leaves base prompt unchanged for empty prefs", () => {
    expect(buildPortfolioAgentInstructions("lite", "  \n")).toBe(
      PORTFOLIO_AGENT_PROMPT_LITE,
    );
    expect(buildPortfolioAgentInstructions("lite")).toBe(
      PORTFOLIO_AGENT_PROMPT_LITE,
    );
  });
});

describe("loadOperatorPreferences", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("loads from Spaces when present", async () => {
    const client = {
      send: vi.fn().mockResolvedValue({
        Body: {
          transformToString: () =>
            Promise.resolve("  Build CompX liquidity.\n"),
        },
      }),
    };

    const body = await loadOperatorPreferences({
      spaces: {
        endpoint: "https://example.digitaloceanspaces.com",
        region: "nyc3",
        bucket: "brownie",
        accessKeyId: "key",
        secretAccessKey: "secret",
        prefix: "brownie-bot",
        client: client as never,
      },
    });

    expect(body).toBe("Build CompX liquidity.");
    expect(client.send).toHaveBeenCalledOnce();
    const command = client.send.mock.calls[0]?.[0] as {
      input: { Bucket?: string; Key?: string };
    };
    expect(command.input.Bucket).toBe("brownie");
    expect(command.input.Key).toBe("brownie-bot/operator-preferences.md");
  });

  it("returns undefined on Spaces 404", async () => {
    const client = {
      send: vi.fn().mockRejectedValue(
        Object.assign(new Error("missing"), {
          name: "NoSuchKey",
          $metadata: { httpStatusCode: 404 },
        }),
      ),
    };

    await expect(
      loadOperatorPreferences({
        spaces: {
          endpoint: "https://example.digitaloceanspaces.com",
          region: "nyc3",
          bucket: "brownie",
          accessKeyId: "key",
          secretAccessKey: "secret",
          prefix: "brownie-bot",
          client: client as never,
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("returns undefined on empty Spaces object", async () => {
    const client = {
      send: vi.fn().mockResolvedValue({
        Body: {
          transformToString: () => Promise.resolve("  \n"),
        },
      }),
    };

    await expect(
      loadOperatorPreferences({
        spaces: {
          endpoint: "https://example.digitaloceanspaces.com",
          region: "nyc3",
          bucket: "brownie",
          accessKeyId: "key",
          secretAccessKey: "secret",
          client: client as never,
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("warns and continues on Spaces permission errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = {
      send: vi.fn().mockRejectedValue(
        Object.assign(new Error("AccessDenied"), {
          name: "AccessDenied",
          $metadata: { httpStatusCode: 403 },
        }),
      ),
    };

    await expect(
      loadOperatorPreferences({
        spaces: {
          endpoint: "https://example.digitaloceanspaces.com",
          region: "nyc3",
          bucket: "brownie",
          accessKeyId: "key",
          secretAccessKey: "secret",
          client: client as never,
        },
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("loads from local path when Spaces is not configured", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brownie-prefs-"));
    tempDirs.push(dir);
    const path = join(dir, "operator-preferences.md");
    await writeFile(path, "Never touch protocol X.\n", "utf8");

    await expect(loadOperatorPreferences({ localPath: path })).resolves.toBe(
      "Never touch protocol X.",
    );
  });

  it("returns undefined when local file is missing", async () => {
    await expect(
      loadOperatorPreferences({
        localPath: join(tmpdir(), "no-such-operator-preferences.md"),
      }),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when local file is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brownie-prefs-"));
    tempDirs.push(dir);
    const path = join(dir, "empty.md");
    await writeFile(path, "\n  \n", "utf8");

    await expect(
      loadOperatorPreferences({ localPath: path }),
    ).resolves.toBeUndefined();
  });
});
