import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadProtocolVerifyConfig } from "../src/cli/config.js";
import {
  DEFAULT_PROTOCOL_VERIFY_FIXTURE_PATH,
  PROTOCOL_VERIFY_CASE_IDS,
  createProtocolVerifyContext,
  loadProtocolVerifyFixture,
  runProtocolVerifyCase,
  type ProtocolVerifyContext,
} from "../src/services/protocol-verify.js";

const enabled =
  process.env.RUN_PROTOCOL_VERIFY === "true" &&
  Boolean(process.env.TEST_WALLET) &&
  Boolean(process.env.TEST_MNEMONIC);

const liveDescribe = enabled ? describe.sequential : describe.skip;
const CASE_TIMEOUT_MS = 5 * 60 * 1_000;

liveDescribe("protocol verify live round-trips", () => {
  let context: ProtocolVerifyContext;

  // beforeAll so `-t folks-usdc-deposit` (etc.) still has a live context;
  // a dedicated "boots" it() is skipped when name-filtered.
  beforeAll(() => {
    const config = loadProtocolVerifyConfig();
    context = createProtocolVerifyContext(config);
    expect(context.walletAddress).toBe(config.TEST_WALLET);
  });

  it("loads a fully pinned discovery fixture", async () => {
    const fixture = await loadProtocolVerifyFixture(
      DEFAULT_PROTOCOL_VERIFY_FIXTURE_PATH,
    );
    for (const caseId of PROTOCOL_VERIFY_CASE_IDS) {
      const pinned = fixture.cases[caseId];
      expect(pinned, `missing case ${caseId}`).toBeDefined();
      if (caseId !== "haystack-swap") {
        expect(
          pinned.opportunityId,
          `${caseId} still needs npm run canix:discover-verify`,
        ).toBeTruthy();
        expect(pinned.enterShapeKey).toBeTruthy();
      }
    }
  });

  for (const caseId of PROTOCOL_VERIFY_CASE_IDS) {
    it(
      `verifies ${caseId}`,
      async () => {
        const fixture = await loadProtocolVerifyFixture(
          DEFAULT_PROTOCOL_VERIFY_FIXTURE_PATH,
        );
        const pinned = fixture.cases[caseId];
        expect(pinned).toBeDefined();
        await runProtocolVerifyCase(context, pinned);
      },
      CASE_TIMEOUT_MS,
    );
  }

  afterAll(async () => {
    await context?.close();
  });
});
