import { z } from "zod";

export const targetId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid ID");
export const targetDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return (
      !Number.isNaN(date.getTime()) &&
      date.toISOString().slice(0, 10) === value &&
      value >= "2000-01-01" &&
      value <= "2100-12-31"
    );
  }, "Enter a valid calendar date");
const fields = {
  title: z.string().trim().min(2).max(150),
  description: z.string().trim().max(5000).optional(),
  targetAmount: z
    .number()
    .positive()
    .max(1e12)
    .refine(
      (n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.001,
      "Use at most two decimal places",
    ),
  startDate: targetDate,
  endDate: targetDate,
};
const orderedDates = (v: { startDate: string; endDate: string }) =>
  v.startDate <= v.endDate &&
  Date.parse(v.endDate) - Date.parse(v.startDate) <= 365 * 86400000;
export const createRevenueTargetInput = z
  .object({ ...fields, branchId: targetId })
  .strict()
  .refine(orderedDates, "End date must follow start date, within one year");
export const createRevenueTargetBatchInput = z
  .object({
    ...fields,
    branchIds: z
      .array(targetId)
      .min(1)
      .max(50)
      .refine(
        (ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length,
        "Select each branch only once",
      ),
    requestId: z.uuid(),
  })
  .strict()
  .refine(orderedDates, "End date must follow start date, within one year");
export const editRevenueTargetInput = z
  .object({
    ...fields,
    archived: z.boolean(),
    version: z.number().int().min(0),
  })
  .strict()
  .refine(orderedDates, "End date must follow start date, within one year");

// Inclusive India calendar days are represented by a half-open UTC interval.
// Never use verifiedAt or createdAt to choose which target a revenue entry belongs to.
export function indiaTargetRange(startDate: string, endDate: string) {
  targetDate.parse(startDate);
  targetDate.parse(endDate);
  if (!orderedDates({ startDate, endDate }))
    throw new Error("Invalid target date range");
  return {
    startAt: new Date(`${startDate}T00:00:00+05:30`),
    endExclusive: new Date(Date.parse(`${endDate}T00:00:00+05:30`) + 86400000),
  };
}
export function revenueTargetProgress(
  targetAmount: number,
  achievedAmount: number,
) {
  const achieved = Math.round((achievedAmount + Number.EPSILON) * 100) / 100;
  const remaining = Math.max(
    0,
    Math.round((targetAmount - achieved) * 100) / 100,
  );
  const percent = Math.round((achieved / targetAmount) * 10000) / 100;
  return {
    achievedAmount: achieved,
    remainingAmount: remaining,
    percent,
    barPercent: Math.max(0, Math.min(100, percent)),
    completed: achieved >= targetAmount,
  };
}
