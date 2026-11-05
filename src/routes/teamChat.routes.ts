import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { authenticate } from "../middleware/auth.middleware.js";
import { Branch } from "../models/Branch.js";
import { TeamChatMessage } from "../models/TeamChatMessage.js";
import { AppError } from "../utils/AppError.js";

export const chatMessageInput = z
  .object({
    text: z.string().trim().min(1, "Enter a message").max(2000),
    clientMessageId: z.uuid(),
  })
  .strict();
const id = z.string().regex(/^[a-f\d]{24}$/i, "Invalid branch or message ID");
const router = Router();
const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
const send = (res: Response, data: unknown, status = 200) => {
  res.status(status).json({ success: true, data });
};
router.use(authenticate);
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
});

router.get(
  "/branches",
  wrap(async (req, res) => {
    send(
      res,
      await Branch.find({
        isActive: true,
        ...(req.user!.role === "head"
          ? {}
          : { _id: { $in: req.user!.branches } }),
      })
        .select("name")
        .sort({ name: 1 })
        .lean(),
    );
  }),
);

// Resolve membership afresh for every read/send; client IDs never grant access.
router.use("/:branchId/messages", async (req, _res, next) => {
  try {
    const branchId = id.parse(req.params.branchId);
    if (req.user!.role !== "head" && !req.user!.branches.includes(branchId))
      throw new AppError("You do not have access to this branch chat", 403);
    if (!(await Branch.exists({ _id: branchId, isActive: true })))
      throw new AppError("Active branch not found", 404);
    next();
  } catch (error) {
    next(error);
  }
});

router.get(
  "/:branchId/messages",
  wrap(async (req, res) => {
    const before = id.optional().parse(req.query.before);
    const branchId = id.parse(req.params.branchId);
    const rows = await TeamChatMessage.find({
      branch: branchId,
      ...(before ? { _id: { $lt: before } } : {}),
    })
      .select("text sender createdAt clientMessageId")
      .populate("sender", "name role")
      .sort({ _id: -1 })
      .limit(51)
      .lean();
    const hasOlder = rows.length > 50;
    const page = rows.slice(0, 50);
    const nextBefore = hasOlder ? String(page[page.length - 1]!._id) : null;
    send(res, { rows: page.reverse(), nextBefore });
  }),
);
const limiter = rateLimit({
  windowMs: 60000,
  limit: 20,
  keyGenerator: (req) => req.user!.id,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many chat messages. Wait a minute and retry.",
  },
});
router.post(
  "/:branchId/messages",
  limiter,
  wrap(async (req, res) => {
    const input = chatMessageInput.parse(req.body);
    const key = {
      branch: id.parse(req.params.branchId),
      sender: req.user!.id,
      clientMessageId: input.clientMessageId,
    };
    let message;
    try {
      message = await TeamChatMessage.findOneAndUpdate(
        key,
        { $setOnInsert: { ...key, text: input.text } },
        { upsert: true, new: true },
      )
        .select("text sender createdAt clientMessageId")
        .populate("sender", "name role")
        .lean();
    } catch (error) {
      // Concurrent retries with the same client ID can race the unique index.
      if ((error as { code?: number }).code !== 11000) throw error;
      message = await TeamChatMessage.findOne(key)
        .select("text sender createdAt clientMessageId")
        .populate("sender", "name role")
        .lean();
      if (!message) throw error;
    }
    if (message?.text !== input.text)
      throw new AppError(
        "This message ID was already used. Refresh the chat before retrying.",
        409,
      );
    send(res, message, 201);
  }),
);
export default router;
