import mongoose, { Schema, Document } from "mongoose";

export interface ICallLog extends Document {
  lead?: mongoose.Types.ObjectId;
  caller?: mongoose.Types.ObjectId;
  branch?: mongoose.Types.ObjectId;
  callId: string;
  fromNumber: string;
  toNumber: string;
  callStatus: "started" | "answered" | "ended" | "missed" | "rejected" | "failed" | "requesting" | "requested" | "unknown";
  provider?: "stringee" | "dialixa";
  requestErrorCode?: string;
  duration: number;
  recordingUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

const callLogSchema = new Schema<ICallLog>(
  {
    lead: { type: Schema.Types.ObjectId, ref: "Lead", index: true },
    caller: { type: Schema.Types.ObjectId, ref: "User", index: true },
    branch: { type: Schema.Types.ObjectId, ref: "Branch", index: true },
    callId: { type: String, required: true, unique: true, index: true },
    fromNumber: { type: String, default: "" },
    toNumber: { type: String, default: "" },
    callStatus: {
      type: String,
      enum: ["started", "answered", "ended", "missed", "rejected", "failed", "requesting", "requested", "unknown"],
      default: "started",
    },
    duration: { type: Number, default: 0 },
    recordingUrl: { type: String, default: "" },
    provider: { type: String, enum: ["stringee", "dialixa"], default: "stringee" },
    requestErrorCode: { type: String },
  },
  { timestamps: true }
);

export const CallLog = mongoose.model<ICallLog>("CallLog", callLogSchema);
