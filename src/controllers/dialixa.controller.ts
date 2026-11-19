import type { Request, Response } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { User } from "../models/User.js";
import { DialixaConfig } from "../models/DialixaConfig.js";
import { dialixaSettingsInput, dialixaAgentInput } from "../validators/dialixa.validator.js";
import { objectId } from "../validators/operations.validator.js";
import { encryptSecret } from "../utils/crypto.js";
import { AppError } from "../utils/AppError.js";
import { getDialixaSession, startDialixaCall } from "../services/dialixa.service.js";

export async function getSession(req: Request, res: Response) {
  res.json({ success: true, data: await getDialixaSession(req.user!.id) });
}

export async function getSettings(_req: Request, res: Response) {
  const config = await DialixaConfig.findById("dialixa").lean();
  res.json({ success: true, data: {
    enabled: !!config?.enabled, apiBaseUrl: config?.apiBaseUrl || "",
    keyConfigured: !!config?.keyConfigured,
  } });
}

export async function updateSettings(req: Request, res: Response) {
  const input = dialixaSettingsInput.parse(req.body);
  const current = await DialixaConfig.findById("dialixa").lean();
  if (input.enabled && !input.apiKey && !current?.keyConfigured) {
    throw new AppError("Save an API key before enabling Dialixa.", 400);
  }
  if (current?.apiBaseUrl && current.apiBaseUrl !== input.apiBaseUrl && !input.apiKey) {
    throw new AppError("Enter the API key again when changing the API base URL.", 400);
  }
  await DialixaConfig.findOneAndUpdate({ _id: "dialixa" }, { $set: {
    enabled: input.enabled, apiBaseUrl: input.apiBaseUrl, updatedBy: req.user!.id,
    ...(input.apiKey ? { apiKeyEncrypted: encryptSecret(input.apiKey), keyConfigured: true } : {}),
  } }, { upsert: true, runValidators: true });
  await getSettings(req, res);
}

function agentScope(req: Request): Record<string, unknown> {
  const user = req.user!;
  if (user.role === "head") return {};
  // Admin can manage their own extension and subordinate users whose complete
  // branch membership is within the Admin's scope. No peer/Head modifications.
  const branches = user.branches.map((id) => new Types.ObjectId(id));
  return { $or: [
    { _id: user.id },
    { role: { $in: ["manager", "employee"] },
      branches: { $in: branches, $not: { $elemMatch: { $nin: branches } } } },
  ] };
}

export async function getAgents(req: Request, res: Response) {
  const { page, search } = z.object({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    search: z.string().trim().max(100).default(""),
  }).parse(req.query);
  const filter: Record<string, unknown> = { ...agentScope(req) };
  if (search) {
    const term = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$and = [{ $or: [{ name: term }, { email: term }, { dialixaExtension: term }] }];
  }
  const [agents, total] = await Promise.all([
    User.find(filter).select("name email role branches isActive dialixaExtension dialerEnabled")
      .populate("branches", "name").sort({ name: 1, _id: 1 }).skip((page - 1) * 25).limit(25).lean(),
    User.countDocuments(filter),
  ]);
  res.json({ success: true, data: agents, pagination: { page, limit: 25, total, totalPages: Math.ceil(total / 25) } });
}

export async function updateAgent(req: Request, res: Response) {
  const id = objectId.parse(req.params.userId);
  const input = dialixaAgentInput.parse(req.body);
  const target = await User.findOne({ ...agentScope(req), _id: id }).select("isActive").lean();
  if (!target) throw new AppError("User not found or outside your management scope.", 404);
  if (input.enabled && !target.isActive) throw new AppError("Activate this CRM user before enabling calling.", 400);
  try {
    const updated = await User.findOneAndUpdate({ ...agentScope(req), _id: id }, {
      $set: { dialerEnabled: input.enabled, ...(input.extension ? { dialixaExtension: input.extension } : {}) },
      ...(!input.extension ? { $unset: { dialixaExtension: 1 } } : {}),
    }, { runValidators: true, returnDocument: "after" }).select("name dialixaExtension dialerEnabled").lean();
    if (!updated) throw new AppError("User no longer belongs to your management scope.", 404);
    res.json({ success: true, data: updated });
  } catch (error) {
    if ((error as { code?: number })?.code === 11000) {
      throw new AppError("This extension is already assigned to another CRM user.", 409, "EXTENSION_ALREADY_ASSIGNED");
    }
    throw error;
  }
}

export async function clickToCall(req: Request, res: Response) {
  const data = await startDialixaCall(req.user!, req.body);
  res.json({ success: true, data });
}
