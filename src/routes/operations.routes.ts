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
import { Lead } from "../models/Lead.js";
import { LeadFollowUp } from "../models/LeadFollowUp.js";
import { LeadActivity } from "../models/LeadActivity.js";
import { LeadAssignmentHistory } from "../models/LeadAssignmentHistory.js";
import { CallLog } from "../models/CallLog.js";
import { User } from "../models/User.js";
import { Branch } from "../models/Branch.js";
import { EmployeeProfile } from "../models/EmployeeProfile.js";
import { SupportTicket } from "../models/SupportTicket.js";
import { AppError } from "../utils/AppError.js";
import {
  objectId,
  queueQuery,
  operationsScope,
  ticketInput,
  ticketUpdate,
  reportWindow,
  nextAssignee,
} from "../validators/operations.validator.js";
import { createLeadFollowUp } from "../services/lead-followup.service.js";

const router = Router();
router.use(authenticate, authorize(PERMISSIONS.LEAD_VIEW));
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
const id = (req: Request) => objectId.parse(req.params.id);
const active = { isDeleted: false };
const openStatuses = [
  "new",
  "assigned",
  "contacted",
  "follow_up",
  "interested",
  "qualified",
];
async function accessibleLead(req: Request, leadId: string) {
  const lead = await Lead.findOne({
    ...operationsScope(req.user!),
    ...active,
    _id: leadId,
  });
  if (!lead) throw new AppError("Lead not found or access denied", 404);
  return lead;
}

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
        .select("name code")
        .sort({ name: 1 })
        .lean(),
    );
  }),
);

router.get(
  "/lead-options",
  wrap(async (req, res) => {
    const search = z.string().trim().min(2).max(100).parse(req.query.search);
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    send(
      res,
      await Lead.find({
        ...operationsScope(req.user!),
        ...active,
        $or: [
          { name: { $regex: escaped, $options: "i" } },
          { phone: { $regex: escaped } },
        ],
      })
        .select("name phone")
        .sort({ name: 1 })
        .limit(30)
        .lean(),
    );
  }),
);

router.get(
  "/followups",
  authorize(PERMISSIONS.LEAD_FOLLOWUP_VIEW),
  wrap(async (req, res) => {
    const q = queueQuery.parse(req.query);
    // Join the CURRENT lead scope as well: an old follow-up must not expose a reassigned lead.
    const match = {
      ...operationsScope(req.user!, q.branchId),
      status: "PENDING",
      scheduledAt: { $lte: new Date(Date.now() + 86400000) },
    };
    const pipeline = [
      { $match: match },
      {
        $lookup: {
          from: "leads",
          localField: "lead",
          foreignField: "_id",
          as: "leadDoc",
        },
      },
      { $unwind: "$leadDoc" },
      {
        $match: {
          "leadDoc.isDeleted": false,
          $expr: {
            $and: [
              { $eq: ["$leadDoc.branch", "$branch"] },
              { $eq: ["$leadDoc.assignedTo", "$assignedTo"] },
            ],
          },
          ...(req.user!.role === "employee"
            ? { "leadDoc.assignedTo": new Types.ObjectId(req.user!.id) }
            : {}),
          ...(req.user!.role !== "head"
            ? {
                "leadDoc.branch": {
                  $in: req.user!.branches.map((b) => new Types.ObjectId(b)),
                },
              }
            : {}),
        },
      },
      { $sort: { scheduledAt: 1 as const, _id: 1 as const } },
      {
        $facet: {
          total: [{ $count: "count" }],
          rows: [
            { $skip: (q.page - 1) * 30 },
            { $limit: 30 },
            {
              $project: {
                scheduledAt: 1,
                remark: 1,
                assignedTo: 1,
                lead: "$leadDoc._id",
                name: "$leadDoc.name",
                phone: "$leadDoc.phone",
              },
            },
          ],
        },
      },
    ];
    const [result] = await LeadFollowUp.aggregate(pipeline);
    send(res, {
      rows: result.rows,
      total: result.total[0]?.count || 0,
      page: q.page,
      now: new Date(),
    });
  }),
);

router.get(
  "/duplicates",
  wrap(async (req, res) => {
    const q = queueQuery.parse(req.query);
    const result = await Lead.aggregate([
      { $match: { ...operationsScope(req.user!, q.branchId), ...active } },
      {
        $group: {
          _id: {
            branch: "$branch",
            country: "$phoneCountryCode",
            phone: "$phone",
          },
          count: { $sum: 1 },
          firstCreated: { $min: "$createdAt" },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1, "_id.phone": 1 } },
      {
        $facet: {
          total: [{ $count: "count" }],
          rows: [{ $skip: (q.page - 1) * 30 }, { $limit: 30 }],
        },
      },
    ]);
    send(res, {
      rows: result[0]?.rows || [],
      total: result[0]?.total[0]?.count || 0,
      page: q.page,
      basis:
        "Exact stored country code and phone within the same branch. Review only; no automatic merge.",
    });
  }),
);

router.get(
  "/reactivation",
  wrap(async (req, res) => {
    const q = queueQuery.parse(req.query);
    // Activity includes calls and messages; unrelated lead edits are not treated as customer contact.
    const cutoff = new Date(Date.now() - q.days * 86400000);
    const base = {
      ...operationsScope(req.user!, q.branchId),
      ...active,
      status: { $in: openStatuses },
      updatedAt: { $lt: cutoff },
    };
    const [result] = await Lead.aggregate([
      { $match: base },
      {
        $lookup: {
          from: "leadactivities",
          let: { leadId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$lead", "$$leadId"] },
                createdAt: { $gte: cutoff },
              },
            },
            { $limit: 1 },
          ],
          as: "recent",
        },
      },
      { $match: { "recent.0": { $exists: false } } },
      {
        $lookup: {
          from: "calllogs",
          let: { leadId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$lead", "$$leadId"] },
                createdAt: { $gte: cutoff },
              },
            },
            { $limit: 1 },
          ],
          as: "recentCalls",
        },
      },
      { $match: { "recentCalls.0": { $exists: false } } },
      {
        $lookup: {
          from: "leadmessages",
          let: { leadId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$lead", "$$leadId"] },
                sentAt: { $gte: cutoff },
              },
            },
            { $limit: 1 },
          ],
          as: "recentMessages",
        },
      },
      { $match: { "recentMessages.0": { $exists: false } } },
      { $sort: { updatedAt: 1 as const, _id: 1 as const } },
      {
        $facet: {
          total: [{ $count: "count" }],
          rows: [
            { $skip: (q.page - 1) * 30 },
            { $limit: 30 },
            {
              $project: {
                name: 1,
                phone: 1,
                phoneCountryCode: 1,
                status: 1,
                updatedAt: 1,
                assignedTo: 1,
              },
            },
          ],
        },
      },
    ]);
    send(res, {
      rows: result.rows,
      total: result.total[0]?.count || 0,
      page: q.page,
      days: q.days,
    });
  }),
);
router.post(
  "/reactivation/:id",
  authorize(PERMISSIONS.LEAD_FOLLOWUP_CREATE),
  wrap(async (req, res) => {
    const lead = await accessibleLead(req, id(req));
    const input = z
      .object({
        scheduledAt: z.iso.datetime(),
        remark: z.string().trim().min(1).max(2000),
      })
      .strict()
      .parse(req.body);
    if (new Date(input.scheduledAt) <= new Date())
      throw new AppError("Choose a future follow-up time", 400);
    // Reuse the CRM's assigned-employee rule, activity history and completion flow.
    if (await LeadFollowUp.exists({ lead: lead._id, status: "PENDING" }))
      throw new AppError(
        "A pending follow-up already exists. Open the lead to reschedule it.",
        409,
      );
    send(
      res,
      await createLeadFollowUp({
        leadId: String(lead._id),
        userId: req.user!.id,
        scheduledAt: new Date(input.scheduledAt),
        remark: input.remark,
      }),
      201,
    );
  }),
);

router.get(
  "/leads/:id/history",
  authorize(PERMISSIONS.LEAD_ACTIVITY_VIEW),
  wrap(async (req, res) => {
    const lead = await accessibleLead(req, id(req));
    const q = queueQuery.parse(req.query);
    const [rows, total] = await Promise.all([
      LeadActivity.find({ lead: lead._id })
        .populate("performedBy", "name")
        .sort({ createdAt: -1, _id: -1 })
        .skip((q.page - 1) * 30)
        .limit(30)
        .lean(),
      LeadActivity.countDocuments({ lead: lead._id }),
    ]);
    send(res, { rows, total, page: q.page });
  }),
);

router.get(
  "/team-report",
  authorize(PERMISSIONS.REPORT_VIEW),
  authorize(PERMISSIONS.CALL_LOG_VIEW),
  wrap(async (req, res) => {
    const q = queueQuery.parse(req.query),
      range = reportWindow(q.days);
    const [calls, leads] = await Promise.all([
      CallLog.aggregate([
        {
          $match: {
            ...operationsScope(req.user!, q.branchId, "caller"),
            createdAt: range,
          },
        },
        {
          $group: {
            _id: "$caller",
            calls: { $sum: 1 },
            connected: { $sum: { $cond: [{ $gt: ["$duration", 0] }, 1, 0] } },
            talkSeconds: { $sum: "$duration" },
          },
        },
      ]),
      Lead.aggregate([
        {
          $match: {
            ...operationsScope(req.user!, q.branchId),
            ...active,
            createdAt: range,
          },
        },
        {
          $group: {
            _id: "$assignedTo",
            leads: { $sum: 1 },
            converted: {
              $sum: { $cond: [{ $eq: ["$status", "converted"] }, 1, 0] },
            },
          },
        },
      ]),
    ]);
    const ids = [
      ...new Set(
        [...calls, ...leads]
          .map((r) => String(r._id))
          .filter((v) => /^[a-f\d]{24}$/i.test(v)),
      ),
    ];
    const users = await User.find({ _id: { $in: ids } })
      .select("name")
      .lean();
    const rows = ids.map((key) => ({
      userId: key,
      name: users.find((u) => String(u._id) === key)?.name || "Former user",
      calls: 0,
      connected: 0,
      talkSeconds: 0,
      leads: 0,
      converted: 0,
      ...calls.find((r) => String(r._id) === key),
      ...leads.find((r) => String(r._id) === key),
    }));
    const unassigned = leads.find((r) => r._id == null)?.leads || 0;
    send(res, {
      rows,
      unassigned,
      range,
      basis:
        "Calls created in the rolling period; connected means recorded talk duration > 0. Leads created in the period grouped by current owner and current converted status. Revenue, deposits and targets remain in the existing Performance module.",
    });
  }),
);

// Manual batch auto-distribution. No background reassignment of existing owners.
router.post(
  "/auto-assign",
  authorize(PERMISSIONS.LEAD_BULK_ASSIGN),
  wrap(async (req, res) => {
    const input = z
      .object({
        branchId: objectId,
        limit: z.number().int().min(1).max(100).default(30),
      })
      .strict()
      .parse(req.body);
    const scope = operationsScope(req.user!, input.branchId);
    if (!(await Branch.exists({ _id: input.branchId, isActive: true })))
      throw new AppError("Active branch required", 400);
    const profiles = await EmployeeProfile.find({
      branch: input.branchId,
      employmentStatus: { $in: ["active", "probation", "notice_period"] },
    })
      .select("user")
      .lean();
    const users = await User.find({
      _id: { $in: profiles.map((p) => p.user) },
      role: "employee",
      isActive: true,
      branches: input.branchId,
    })
      .select("_id")
      .sort({ _id: 1 })
      .lean();
    if (!users.length)
      throw new AppError(
        "No active employees with profiles in this branch",
        409,
      );
    const counts = await Lead.aggregate([
      {
        $match: {
          branch: new Types.ObjectId(input.branchId),
          ...active,
          status: { $in: openStatuses },
          assignedTo: { $in: users.map((u) => u._id) },
        },
      },
      { $group: { _id: "$assignedTo", count: { $sum: 1 } } },
    ]);
    const loads = users.map((u) => ({
      id: String(u._id),
      count: counts.find((c) => String(c._id) === String(u._id))?.count || 0,
    }));
    let assigned = 0;
    // Transactions keep assignment and history together; each conditional write protects
    // against another manager assigning the same lead. A standalone MongoDB must use a replica set.
    for (let i = 0; i < input.limit; i++) {
      const target = nextAssignee(loads)!;
      const session = await Lead.startSession();
      let claimed = false;
      try {
        await session.withTransaction(async () => {
          claimed = false;
          const now = new Date();
          const lead = await Lead.findOneAndUpdate(
            { ...scope, ...active, assignedTo: null, status: "new" },
            {
              $set: {
                assignedTo: new Types.ObjectId(target.id),
                assignedBy: new Types.ObjectId(req.user!.id),
                assignedAt: now,
                status: "assigned",
              },
            },
            { session, new: true, sort: { createdAt: 1, _id: 1 } },
          );
          if (!lead) return;
          await LeadAssignmentHistory.create(
            [
              {
                lead: lead._id,
                branch: lead.branch,
                assignedTo: lead.assignedTo,
                assignedBy: req.user!.id,
                assignedAt: now,
              },
            ],
            { session },
          );
          await LeadActivity.create(
            [
              {
                lead: lead._id,
                activityType: "assigned",
                performedBy: req.user!.id,
                remark: "Assigned to least-loaded active employee",
                metadata: { assignedTo: target.id, method: "least_load" },
              },
            ],
            { session },
          );
          claimed = true;
        });
      } catch (error) {
        if (assigned > 0) {
          send(res, {
            assigned,
            partial: true,
            message:
              "Batch stopped after a database error. Completed assignments were retained; refresh before retrying.",
          });
          return;
        }
        throw error;
      } finally {
        await session.endSession();
      }
      if (!claimed) break;
      target.count++;
      assigned++;
    }
    send(res, { assigned, partial: false });
  }),
);

// Employees see tickets they created. Management stays inside its own branches.
const ticketsScope = (req: Request) =>
  operationsScope(req.user!, undefined, "createdBy");
router.get(
  "/tickets",
  wrap(async (req, res) => {
    const q = queueQuery.parse(req.query);
    const status = z
      .enum(["open", "in_progress", "resolved", "closed"])
      .optional()
      .parse(req.query.status);
    const match = { ...ticketsScope(req), ...(status ? { status } : {}) };
    const [rows, total] = await Promise.all([
      SupportTicket.find(match)
        .select("-events")
        .populate("lead", "name")
        .populate("assignedTo", "name")
        .sort({ createdAt: -1 })
        .skip((q.page - 1) * 30)
        .limit(30)
        .lean(),
      SupportTicket.countDocuments(match),
    ]);
    send(res, { rows, total, page: q.page });
  }),
);
router.post(
  "/tickets",
  wrap(async (req, res) => {
    const input = ticketInput.parse(req.body),
      lead = await accessibleLead(req, input.leadId);
    if (!lead.branch)
      throw new AppError(
        "Assign the lead to a branch before opening a ticket",
        400,
      );
    send(
      res,
      await SupportTicket.create({
        ...input,
        lead: lead._id,
        branch: lead.branch,
        createdBy: req.user!.id,
        events: [{ actor: req.user!.id, action: "created" }],
      }),
      201,
    );
  }),
);
router.get(
  "/tickets/:id",
  wrap(async (req, res) => {
    const ticket = await SupportTicket.findOne({
      ...ticketsScope(req),
      _id: id(req),
    })
      .populate("lead", "name")
      .populate("assignedTo", "name")
      .populate("events.actor", "name")
      .lean();
    if (!ticket) throw new AppError("Ticket not found", 404);
    send(res, ticket);
  }),
);
router.get(
  "/tickets/:id/assignees",
  wrap(async (req, res) => {
    if (req.user!.role === "employee")
      throw new AppError("Management access required", 403);
    const ticket = await SupportTicket.findOne({
      ...ticketsScope(req),
      _id: id(req),
    })
      .select("branch")
      .lean();
    if (!ticket) throw new AppError("Ticket not found", 404);
    send(
      res,
      await User.find({
        isActive: true,
        role: { $in: ["head", "admin", "manager"] },
        $or: [{ role: "head" }, { branches: ticket.branch }],
      })
        .select("name")
        .sort({ name: 1 })
        .lean(),
    );
  }),
);
router.patch(
  "/tickets/:id",
  wrap(async (req, res) => {
    const input = ticketUpdate.parse(req.body),
      ticket = await SupportTicket.findOne({
        ...ticketsScope(req),
        _id: id(req),
      });
    if (!ticket) throw new AppError("Ticket not found", 404);
    if (req.user!.role === "employee" && (input.status || input.assignedTo))
      throw new AppError(
        "Only management can assign or change ticket status",
        403,
      );
    if (
      input.assignedTo &&
      !(await User.exists({
        _id: input.assignedTo,
        isActive: true,
        role: { $in: ["head", "admin", "manager"] },
        $or: [{ role: "head" }, { branches: ticket.branch }],
      }))
    )
      throw new AppError(
        "Choose active management with access to the ticket branch",
        400,
      );
    const set: Record<string, unknown> = {};
    if (input.status) {
      set.status = input.status;
      set.resolvedAt = ["resolved", "closed"].includes(input.status)
        ? new Date()
        : null;
    }
    if (input.assignedTo) set.assignedTo = new Types.ObjectId(input.assignedTo);
    const updated = await SupportTicket.findOneAndUpdate(
      {
        ...ticketsScope(req),
        _id: ticket._id,
        version: input.version,
        "events.499": { $exists: false },
      },
      {
        $set: set,
        $inc: { version: 1 },
        $push: {
          events: {
            actor: req.user!.id,
            action: input.status || (input.assignedTo ? "assigned" : "comment"),
            comment: input.comment,
            assignedTo: input.assignedTo,
            at: new Date(),
          },
        },
      },
      { new: true },
    );
    if (!updated)
      throw new AppError(
        "Ticket changed or reached its activity limit. Refresh before retrying.",
        409,
      );
    send(res, updated);
  }),
);
export default router;
