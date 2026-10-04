import { Router, type IRouter } from "express";
import { GetDashboardSummaryResponse } from "@workspace/api-zod";
import { requireAccount } from "../lib/auth-middleware";
import {
  getDashboardCounts,
  getRecentConnections,
  getRecentTokens,
} from "../lib/auth-store";

const router: IRouter = Router();

router.get("/dashboard", requireAccount, async (req, res): Promise<void> => {
  try {
    const userId = req.accountUser!.id;
    const [counts, recentConnections, recentTokens] = await Promise.all([
      getDashboardCounts(userId),
      getRecentConnections(userId),
      getRecentTokens(userId),
    ]);
    res.json(
      GetDashboardSummaryResponse.parse({
        user: req.accountUser,
        ...counts,
        recentConnections,
        recentTokens,
      }),
    );
  } catch (error) {
    req.log.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "Could not load account overview",
    );
    res.status(500).json({ error: "Account overview could not be loaded." });
  }
});

export default router;