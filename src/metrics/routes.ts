import { type Request, type Response, Router } from "express";
import { jsonErrors } from "../http/routes";
import { computeRevenue, type DateRange } from "./revenue";

export const metricsRouter = Router();

const FAILED = "failed to compute revenue";

function readRange(req: Request, res: Response): DateRange | null {
  const { from, to } = req.query;
  if (typeof from !== "string" || typeof to !== "string") {
    res.status(400).json({ error: "from and to query params are required" });
    return null;
  }
  return { from, to };
}

metricsRouter.get(
  "/summary",
  jsonErrors(async (req, res) => {
    const range = readRange(req, res);
    if (range === null) {
      return;
    }

    const revenue = await computeRevenue(range);
    res.json(
      revenue.map(({ currency, total_cents }) => ({ currency, total_cents })),
    );
  }, FAILED),
);

metricsRouter.get(
  "/breakdown",
  jsonErrors(async (req, res) => {
    const range = readRange(req, res);
    if (range === null) {
      return;
    }

    const revenue = await computeRevenue(range);
    res.json(revenue.map(({ currency, by_day }) => ({ currency, by_day })));
  }, FAILED),
);
