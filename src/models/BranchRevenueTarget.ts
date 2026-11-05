import { Schema, model } from "mongoose";

const schema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 150 },
    branch: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    targetAmount: { type: Number, required: true, min: 0.01 },
    startDate: { type: String, required: true },
    endDate: { type: String, required: true },
    startAt: { type: Date, required: true },
    endExclusive: { type: Date, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    version: { type: Number, default: 0 },
    archived: { type: Boolean, default: false },
  },
  { timestamps: true },
);
schema.index({ branch: 1, createdAt: -1 });
export const BranchRevenueTarget = model("BranchRevenueTarget", schema);
