import { z } from "zod";
import { Types } from "mongoose";
import type { AuthenticatedUser } from "../types/auth.js";
import { AppError } from "../utils/AppError.js";

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid ID");
export const queueQuery = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  days: z.coerce.number().int().min(1).max(365).default(14),
  branchId: objectId.optional(),
});
export const ticketInput = z
  .object({
    leadId: objectId,
    subject: z.string().trim().min(3).max(150),
    description: z.string().trim().min(3).max(4000),
    category: z.enum(["deposit", "withdrawal", "login", "technical", "other"]),
    priority: z.enum(["normal", "high", "urgent"]).default("normal"),
  })
  .strict();
export const ticketUpdate = z
  .object({
    status: z.enum(["open", "in_progress", "resolved", "closed"]).optional(),
    assignedTo: objectId.optional(),
    comment: z.string().trim().min(1).max(2000).optional(),
    version: z.number().int().min(0),
  })
  .strict()
  .refine((v) => !!(v.status || v.assignedTo || v.comment), "Provide a change");

// Fail closed: an employee with no branch never gets a global data scope.
export function operationsScope(
  user: AuthenticatedUser,
  branchId?: string,
  ownerField = "assignedTo",
) {
  if (branchId && user.role !== "head" && !user.branches.includes(branchId)) {
    throw new AppError("You do not have access to this branch", 403);
  }
  const scope: Record<string, unknown> = {};
  if (branchId) scope.branch = new Types.ObjectId(branchId);
  else if (user.role !== "head")
    scope.branch = { $in: user.branches.map((id) => new Types.ObjectId(id)) };
  if (user.role === "employee") scope[ownerField] = new Types.ObjectId(user.id);
  return scope;
}

export function reportWindow(days: number, now = new Date()) {
  return { $gte: new Date(now.getTime() - days * 86400000), $lte: now };
}

export function nextAssignee(loads: { id: string; count: number }[]) {
  return [...loads].sort(
    (a, b) => a.count - b.count || a.id.localeCompare(b.id),
  )[0];
}
