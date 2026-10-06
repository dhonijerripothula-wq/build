import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import cookieParser from "cookie-parser";
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
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || false,
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use("/api", router);
app.use("/api", (_req, res): void => {
  res.status(404).json({ error: "API route not found." });
});
app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction): void => {
  const status = error && typeof error === "object" && "status" in error
    ? Number((error as { status: unknown }).status)
    : 500;
  if (status >= 500) req.log.error({ err: error }, "Unhandled API request error");
  res.status(status === 413 ? 413 : status === 400 ? 400 : 500).json({
    error: status === 413
      ? "Request is larger than the allowed upload size."
      : status === 400
        ? "Request body is invalid."
        : "The server could not complete this request.",
  });
});

export default app;
