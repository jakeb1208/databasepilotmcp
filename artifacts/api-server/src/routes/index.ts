import { Router, type IRouter } from "express";
import authRouter from "./auth";
import connectionsRouter from "./connections";
import dashboardRouter from "./dashboard";
import healthRouter from "./health";
import mcpRouter from "./mcp";
import tokensRouter from "./tokens";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(dashboardRouter);
router.use(connectionsRouter);
router.use(tokensRouter);
router.use(mcpRouter);

export default router;
