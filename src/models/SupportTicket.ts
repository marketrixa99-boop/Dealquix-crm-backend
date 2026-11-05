import { Schema, model } from "mongoose";

const event = new Schema(
  {
    actor: { type: Schema.Types.ObjectId, ref: "User", required: true },
    action: { type: String, required: true },
    comment: { type: String, maxlength: 2000 },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User" },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);
const schema = new Schema(
  {
    lead: { type: Schema.Types.ObjectId, ref: "Lead", required: true },
    branch: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User" },
    subject: { type: String, required: true, maxlength: 150 },
    description: { type: String, required: true, maxlength: 4000 },
    category: {
      type: String,
      enum: ["deposit", "withdrawal", "login", "technical", "other"],
      required: true,
    },
    priority: {
      type: String,
      enum: ["normal", "high", "urgent"],
      default: "normal",
    },
    status: {
      type: String,
      enum: ["open", "in_progress", "resolved", "closed"],
      default: "open",
    },
    version: { type: Number, default: 0 },
    resolvedAt: Date,
    events: [event],
  },
  { timestamps: true },
);
schema.index({ branch: 1, status: 1, createdAt: -1 });
schema.index({ createdBy: 1, createdAt: -1 });
export const SupportTicket = model("SupportTicket", schema);
