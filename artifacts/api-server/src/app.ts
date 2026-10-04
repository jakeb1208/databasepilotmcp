import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { existsSync } from "node:fs";
import path from "node:path";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use("/api", router);

const webDist = path.resolve(
  process.cwd(),
  "../database-pilot-console/dist/public",
);
if (existsSync(path.join(webDist, "index.html"))) {
  app.use(express.static(webDist, { index: false, maxAge: "1h" }));
  app.get("/{*splat}", (req, res, next) => {
    if (req.path === "/api" || req.path.startsWith("/api/")) {
      next();
      return;
    }
    res.sendFile(path.join(webDist, "index.html"));
  });
}

export default app;
