import express from "express";
import { env } from "../config/env";
import { runSyncJob } from "../jobs/sync-job";
import { metricsRouter } from "../metrics/routes";
import { jsonErrors, recordsRouter } from "./routes";

const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post(
  "/sync",
  jsonErrors(async (_req, res) => {
    res.json({ summaries: await runSyncJob() });
  }, "sync job failed"),
);

app.use("/records", recordsRouter);
app.use("/metrics", metricsRouter);

app.listen(env.PORT, () => {
  console.log(`[http] listening on ${env.PORT}`);
});
