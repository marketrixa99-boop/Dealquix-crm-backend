import { Router } from "express";
import rateLimit from "express-rate-limit";
import { createHash, timingSafeEqual } from "node:crypto";
import mongoose, { Schema, Types, type Model } from "mongoose";
import { z } from "zod";
import { Lead } from "../models/Lead.js";
import { User } from "../models/User.js";
import { ROLES } from "../constants/roles.js";

// A separate unique receipt makes retries safe across instances and restarts.
interface WebsiteReceipt { _id: string; lead: Types.ObjectId }
const Receipt: Model<WebsiteReceipt> = mongoose.models.WebsiteLeadReceipt || mongoose.model<WebsiteReceipt>("WebsiteLeadReceipt", new Schema<WebsiteReceipt>({
  _id: { type: String, required: true },
  lead: { type: Schema.Types.ObjectId, required: true },
}, { timestamps: true }));
export const websiteLeadInput = z.object({
  submissionId: z.uuid(),
  name: z.string().trim().min(2).max(150),
  email: z.email().max(150),
  phoneCountryCode: z.string().regex(/^\+[1-9]\d{0,3}$/),
  phone: z.string().regex(/^\d{6,15}$/),
  message: z.string().trim().max(5000).default(""),
}).strict();

const router = Router();
router.post("/masterxtrader", rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false }), async (req, res, next) => {
  try {
    const secret = process.env.MASTERXTRADER_LEAD_SECRET;
    const ownerEmail = process.env.MASTERXTRADER_LEAD_OWNER_EMAIL;
    if (!secret || secret.length < 32 || !ownerEmail) return res.status(503).json({ success: false });
    const supplied = req.get("x-website-lead-key") || "";
    const digest = (value: string) => createHash("sha256").update(value).digest();
    if (!timingSafeEqual(digest(secret), digest(supplied))) return res.status(401).json({ success: false });
    const input = websiteLeadInput.parse(req.body);
    const receiptId = `masterxtrader:${input.submissionId}`;
    const existing = await Receipt.findById(receiptId).lean();
    if (existing) return res.status(200).json({ success: true, data: { id: existing.lead } });
    const owner = await User.findOne({ email: ownerEmail.toLowerCase(), role: ROLES.HEAD, isActive: true }).select("_id");
    if (!owner) return res.status(503).json({ success: false });
    const leadId = new Types.ObjectId();
    try {
      await mongoose.connection.transaction(async session => {
        await Receipt.create([{ _id: receiptId, lead: leadId }], { session });
        await Lead.create([{
          _id: leadId, name: input.name, email: input.email,
          phoneCountryCode: input.phoneCountryCode, phone: input.phone,
          message: input.message, source: "MasterXTrader Website", sourceType: "API",
          externalId: receiptId, createdBy: owner._id, status: "new", isDeleted: false,
        }], { session });
      });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      const replay = await Receipt.findById(receiptId).lean();
      if (!replay) throw error;
      return res.status(200).json({ success: true, data: { id: replay.lead } });
    }
    return res.status(201).json({ success: true, data: { id: leadId } });
  } catch (error) { next(error); }
});
export default router;
