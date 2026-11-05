import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { authenticate } from "../middleware/auth.middleware.js";
import { authorize } from "../middleware/authorize.middleware.js";
import { PERMISSIONS } from "../constants/permissions.js";
import { Branch } from "../models/Branch.js";
import { BranchRevenueTarget } from "../models/BranchRevenueTarget.js";
import { AppError } from "../utils/AppError.js";
import { createBranchRevenueTasks } from "../services/revenue-target-batch.service.js";
import {
  createRevenueTargetInput,
  editRevenueTargetInput,
  targetId,
  indiaTargetRange,
  revenueTargetProgress,
} from "../validators/revenueTarget.validator.js";

const router = Router();
type TargetRow = {
  _id: Types.ObjectId;
  title: string;
  description?: string;
  branch: Types.ObjectId;
  branchName: string;
  targetAmount: number;
  verifiedAmount: number;
  verifiedEntries: number;
  startDate: string;
  endDate: string;
  startAt: Date;
  endExclusive: Date;
  version: number;
  archived: boolean;
  createdAt: Date;
};
router.use(authenticate, authorize(PERMISSIONS.TASK_VIEW));
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
});
const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
const send = (res: Response, data: unknown, status = 200) => {
  res.status(status).json({ success: true, data });
};
const headOnly = (req: Request, _res: Response, next: NextFunction) => {
  next(
    req.user!.role === "head"
      ? undefined
      : new AppError(
          "Only Head can create or edit branch revenue targets",
          403,
        ),
  );
};
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

router.get(
  "/",
  wrap(async (req, res) => {
    const q = z
      .object({
        branchId: targetId.optional(),
        page: z.coerce.number().int().min(1).max(10000).default(1),
        limit: z.coerce.number().int().min(1).max(30).default(12),
        archived: z.enum(["true", "false"]).default("false"),
      })
      .parse(req.query);
    if (
      q.branchId &&
      req.user!.role !== "head" &&
      !req.user!.branches.includes(q.branchId)
    )
      throw new AppError("Branch access denied", 403);
    const scope =
      req.user!.role === "head"
        ? {}
        : {
            branch: {
              $in: req.user!.branches.map((b) => new Types.ObjectId(b)),
            },
          };
    const [result] = await BranchRevenueTarget.aggregate<{
      rows: TargetRow[];
      total: { count: number }[];
    }>([
      {
        $match: {
          ...scope,
          ...(q.branchId ? { branch: new Types.ObjectId(q.branchId) } : {}),
          archived: q.archived === "true",
        },
      },
      { $sort: { createdAt: -1, _id: -1 } },
      {
        $facet: {
          total: [{ $count: "count" }],
          rows: [
            { $skip: (q.page - 1) * q.limit },
            { $limit: q.limit },
            {
              $lookup: {
                from: "branches",
                localField: "branch",
                foreignField: "_id",
                as: "branchDoc",
              },
            },
            {
              $lookup: {
                from: "revenues",
                let: {
                  branchId: "$branch",
                  start: "$startAt",
                  end: "$endExclusive",
                },
                pipeline: [
                  {
                    $match: {
                      status: "VERIFIED",
                      $expr: {
                        $and: [
                          { $eq: ["$branch", "$$branchId"] },
                          { $gte: ["$date", "$$start"] },
                          { $lt: ["$date", "$$end"] },
                        ],
                      },
                    },
                  },
                  // One row per Revenue document: no joins with employees or daily reports that multiply totals.
                  {
                    $group: {
                      _id: null,
                      amount: { $sum: "$amount" },
                      entries: { $sum: 1 },
                    },
                  },
                ],
                as: "revenue",
              },
            },
            {
              $project: {
                title: 1,
                description: 1,
                branch: 1,
                targetAmount: 1,
                startDate: 1,
                endDate: 1,
                startAt: 1,
                endExclusive: 1,
                version: 1,
                archived: 1,
                createdAt: 1,
                branchName: {
                  $ifNull: [
                    { $arrayElemAt: ["$branchDoc.name", 0] },
                    "Former branch",
                  ],
                },
                verifiedAmount: {
                  $ifNull: [{ $arrayElemAt: ["$revenue.amount", 0] }, 0],
                },
                verifiedEntries: {
                  $ifNull: [{ $arrayElemAt: ["$revenue.entries", 0] }, 0],
                },
              },
            },
          ],
        },
      },
    ]);
    const now = new Date();
    const rows = (result?.rows || []).map((row) => {
      const progress = revenueTargetProgress(
        row.targetAmount,
        row.verifiedAmount,
      );
      const phase = row.archived
        ? "archived"
        : now < row.startAt
          ? "upcoming"
          : progress.completed
            ? "completed"
            : now >= row.endExclusive
              ? "ended"
              : "active";
      const { verifiedAmount, startAt, endExclusive, ...target } = row;
      return { ...target, ...progress, phase };
    });
    send(res, {
      rows,
      total: result?.total[0]?.count || 0,
      page: q.page,
      limit: q.limit,
      timezone: "Asia/Kolkata",
      computedAt: now.toISOString(),
    });
  }),
);

router.post(
  "/batch",
  headOnly,
  wrap(async (req, res) => {
    send(res, await createBranchRevenueTasks(req.body, req.user!.id), 201);
  }),
);
router.post(
  "/",
  headOnly,
  wrap(async (req, res) => {
    const input = createRevenueTargetInput.parse(req.body);
    if (!(await Branch.exists({ _id: input.branchId, isActive: true })))
      throw new AppError("Choose an active branch", 400);
    const target = await BranchRevenueTarget.create({
      title: input.title,
      description: input.description,
      branch: input.branchId,
      targetAmount: input.targetAmount,
      startDate: input.startDate,
      endDate: input.endDate,
      ...indiaTargetRange(input.startDate, input.endDate),
      createdBy: req.user!.id,
      updatedBy: req.user!.id,
    });
    send(res, target, 201);
  }),
);
router.patch(
  "/:id",
  headOnly,
  wrap(async (req, res) => {
    const id = targetId.parse(req.params.id),
      input = editRevenueTargetInput.parse(req.body);
    const { version, ...fields } = input;
    const updated = await BranchRevenueTarget.findOneAndUpdate(
      { _id: id, version },
      {
        $set: {
          ...fields,
          ...indiaTargetRange(input.startDate, input.endDate),
          updatedBy: req.user!.id,
        },
        $inc: { version: 1 },
      },
      { new: true, runValidators: true },
    );
    if (!updated)
      throw new AppError(
        "Target changed or no longer exists. Refresh before editing.",
        409,
      );
    send(res, updated);
  }),
);
export default router;
