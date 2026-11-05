import { Schema, model } from "mongoose";

// The primary key combines the authenticated Head and a client request UUID.
// It prevents duplicate cards when an uncertain network response is retried.
const schema = new Schema(
  {
    _id: { type: String, required: true },
    fingerprint: { type: String, required: true },
  },
  { timestamps: true },
);
export const RevenueTargetBatch = model("RevenueTargetBatch", schema);
