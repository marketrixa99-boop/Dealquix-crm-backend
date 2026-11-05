import { Branch } from "../models/Branch.js";
import { BranchRevenueTarget } from "../models/BranchRevenueTarget.js";
import { RevenueTargetBatch } from "../models/RevenueTargetBatch.js";
import {
  createRevenueTargetBatchInput,
  indiaTargetRange,
} from "../validators/revenueTarget.validator.js";
import { AppError } from "../utils/AppError.js";

export async function createBranchRevenueTasks(
  rawInput: unknown,
  actorId: string,
) {
  const input = createRevenueTargetBatchInput.parse(rawInput);
  const branchIds = input.branchIds.map((id) => id.toLowerCase()).sort();
  const payload = {
    title: input.title,
    description: input.description || "",
    targetAmount: input.targetAmount,
    startDate: input.startDate,
    endDate: input.endDate,
  };
  const fingerprint = JSON.stringify({ ...payload, branchIds });
  const batchId = `${actorId}:${input.requestId}`;
  const result = async () => ({
    count: branchIds.length,
    targets: await BranchRevenueTarget.find({ batch: batchId })
      .select("_id branch title targetAmount")
      .lean(),
  });
  const existing = await RevenueTargetBatch.findById(batchId).lean();
  if (existing) {
    if (existing.fingerprint !== fingerprint)
      throw new AppError(
        "This request was already used with different details. Start a new task.",
        409,
      );
    return result();
  }
  const branches = await Branch.find({
    _id: { $in: branchIds },
    isActive: true,
  })
    .select("_id")
    .lean();
  if (branches.length !== branchIds.length)
    throw new AppError(
      "Every selected branch must exist and be active. No tasks were created.",
      400,
    );
  const session = await BranchRevenueTarget.startSession();
  try {
    await session.withTransaction(async () => {
      const previous = await RevenueTargetBatch.findById(batchId)
        .session(session)
        .lean();
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new AppError(
            "Task request details changed. Start a new task.",
            409,
          );
        return;
      }
      await RevenueTargetBatch.create([{ _id: batchId, fingerprint }], {
        session,
      });
      await BranchRevenueTarget.create(
        branchIds.map((branch) => ({
          ...payload,
          ...indiaTargetRange(input.startDate, input.endDate),
          branch,
          batch: batchId,
          createdBy: actorId,
          updatedBy: actorId,
        })),
        { session },
      );
    });
  } catch (error) {
    // A simultaneous retry may win the primary-key insertion after our read.
    if ((error as { code?: number }).code !== 11000) throw error;
    const saved = await RevenueTargetBatch.findById(batchId).lean();
    if (!saved || saved.fingerprint !== fingerprint)
      throw new AppError(
        "Task request conflict. Refresh and review before retrying.",
        409,
      );
  } finally {
    await session.endSession();
  }
  return result();
}
