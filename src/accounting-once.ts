import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app, accountingService } = createApp(config);

try {
  const run = await accountingService.run("wait");
  process.stdout.write(
    `${JSON.stringify(
      {
        id: run.id,
        status: run.status,
        totalValueUsd: run.summary?.latestTotalValueUsd,
        pnlUsd: run.summary?.pnlUsd,
        pnlAvailable: run.summary?.pnlAvailable,
        defiByProtocol: run.summary?.defiByProtocol,
        walletAsaValueUsd: run.summary?.walletAsaValueUsd,
        algoBalance: run.summary?.algoBalance,
        minimumBalance: run.summary?.minimumBalance,
        unpricedAssetIds: run.summary?.unpricedAssetIds,
        notes: run.summary?.notes,
        snapshotKey: run.snapshotKey,
        error: run.error,
        notificationError: run.notificationError,
      },
      null,
      2,
    )}\n`,
  );
  if (run.status === "failed") {
    process.exitCode = 1;
  }
} finally {
  await app.close();
}
