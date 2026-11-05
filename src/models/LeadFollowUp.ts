import mongoose, { Document, Schema } from "mongoose";

import {
  LEAD_FOLLOW_UP_STATUS,
  type LeadFollowUpStatus,
} from "../constants/leadFollowUpStatus.js";

export interface ILeadFollowUp extends Document {
  reminderSentAt?: Date;
  escalatedAt?: Date;
  lead: mongoose.Types.ObjectId;

  assignedTo: mongoose.Types.ObjectId;

  createdBy: mongoose.Types.ObjectId;

  branch: mongoose.Types.ObjectId;

  scheduledAt: Date;

  status: LeadFollowUpStatus;

  remark?: string;

  completedAt?: Date;

  completedBy?: mongoose.Types.ObjectId;

  createdAt: Date;

  updatedAt: Date;
}

const leadFollowUpSchema = new Schema<ILeadFollowUp>(
  {
    reminderSentAt: Date,
    escalatedAt: Date,
    lead: {
      type: Schema.Types.ObjectId,
      ref: "Lead",
      required: true,
      index: true,
    },

    assignedTo: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    branch: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      index: true,
    },

    scheduledAt: {
      type: Date,
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: Object.values(LEAD_FOLLOW_UP_STATUS),
      default: LEAD_FOLLOW_UP_STATUS.PENDING,
      required: true,
      index: true,
    },

    remark: {
      type: String,
      trim: true,
      maxlength: 2000,
    },

    completedAt: {
      type: Date,
    },

    completedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
  },
);

leadFollowUpSchema.index({
  assignedTo: 1,
  status: 1,
  scheduledAt: 1,
});

leadFollowUpSchema.index({
  lead: 1,
  scheduledAt: -1,
});

leadFollowUpSchema.index({
  branch: 1,
  status: 1,
  scheduledAt: 1,
});

export const LeadFollowUp = mongoose.model<ILeadFollowUp>(
  "LeadFollowUp",
  leadFollowUpSchema,
);
