import { Schema, model } from "mongoose";

// A single Dialixa account serves this CRM. Access stays off until configured by Head.
const schema = new Schema({
  _id: { type: String, default: "dialixa" },
  enabled: { type: Boolean, default: false },
  apiBaseUrl: { type: String, default: "" },
  apiKeyEncrypted: { type: String, select: false, default: "" },
  keyConfigured: { type: Boolean, default: false },
  updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
}, { timestamps: true });

export const DialixaConfig = model("DialixaConfig", schema);

// These atomic leases/counters work across server processes. TTL is cleanup only;
// expiration is checked explicitly when acquiring a lease.
const lockSchema = new Schema({
  _id: String,
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
});
export const DialixaCallLock = model("DialixaCallLock", lockSchema);

const rateSchema = new Schema({
  _id: String,
  count: { type: Number, required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
});
export const DialixaRateBucket = model("DialixaRateBucket", rateSchema);
