import type { RequestHandler } from "express";

export const requireDatabase = (connect: () => Promise<void>): RequestHandler =>
  async (_req, res, next) => {
    try {
      await connect();
      next();
    } catch {
      // Driver errors can contain credentials/hosts. Do not log or return them.
      console.error("Database connection unavailable");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Retry-After", "5");
      res.status(503).json({
        success: false,
        code: "DATABASE_UNAVAILABLE",
        message: "Service temporarily unavailable. Please try again.",
      });
    }
  };
