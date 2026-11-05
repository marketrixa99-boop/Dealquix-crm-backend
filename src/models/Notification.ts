import mongoose, { Document, Schema, Types, Model } from "mongoose";

export const NOTIFICATION_TYPES = {
  // --- USER & AUTH ---
  USER_LOGIN: "USER_LOGIN",
  USER_LOGOUT: "USER_LOGOUT",
  USER_CREATED: "USER_CREATED",
  USER_UPDATED: "USER_UPDATED",
  USER_BRANCH_ASSIGNED: "USER_BRANCH_ASSIGNED",
  USER_STATUS_UPDATED: "USER_STATUS_UPDATED",

  // Employee related notifications
  EMPLOYEE_CREATED: "EMPLOYEE_CREATED",
  EMPLOYEE_UPDATED: "EMPLOYEE_UPDATED",
  EMPLOYEE_DEACTIVATED: "EMPLOYEE_DEACTIVATED",
  EMPLOYEE_REACTIVATED: "EMPLOYEE_REACTIVATED",

  // Branch related notifications
  BRANCH_CREATED: "BRANCH_CREATED",
  BRANCH_UPDATED: "BRANCH_UPDATED",
  BRANCH_DEACTIVATED: "BRANCH_DEACTIVATED",
  BRANCH_REACTIVATED: "BRANCH_REACTIVATED",
  BRANCH_ASSIGNED: "BRANCH_ASSIGNED",

  // --- ATTENDANCE & LEAVE ---
  ATTENDANCE_CHECK_IN: "ATTENDANCE_CHECK_IN",
  ATTENDANCE_CHECK_OUT: "ATTENDANCE_CHECK_OUT",
  ATTENDANCE_LATE_CHECKIN_SUBMITTED: "ATTENDANCE_LATE_CHECKIN_SUBMITTED",
  ATTENDANCE_LATE_CHECKIN_APPROVED: "ATTENDANCE_LATE_CHECKIN_APPROVED",
  LEAVE_CREATED: "LEAVE_CREATED",
  LEAVE_APPROVED: "LEAVE_APPROVED",
  LEAVE_REJECTED: "LEAVE_REJECTED",
  LEAVE_CANCELLED: "LEAVE_CANCELLED",

  // --- LEADS & CUSTOMERS ---
  LEAD_CREATED: "LEAD_CREATED",
  LEAD_UPDATED: "LEAD_UPDATED",
  LEAD_ASSIGNED: "LEAD_ASSIGNED",
  LEAD_REASSIGNED: "LEAD_REASSIGNED",
  LEAD_BULK_ASSIGNED: "LEAD_BULK_ASSIGNED",
  LEAD_FOLLOWUP_CREATED: "LEAD_FOLLOWUP_CREATED",
  CUSTOMER_CREATED: "CUSTOMER_CREATED",

  // --- TASKS ---
  TASK_CREATED: "TASK_CREATED",
  TASK_ASSIGNED: "TASK_ASSIGNED",
  TASK_UPDATED: "TASK_UPDATED",
  TASK_COMPLETED: "TASK_COMPLETED",

  // --- REVENUE & FINANCIALS ---
  REVENUE_CREATED: "REVENUE_CREATED",
  REVENUE_VERIFIED: "REVENUE_VERIFIED",

  // --- DAILY REPORTS ---
  DAILY_REPORT_REVIEWED: "DAILY_REPORT_REVIEWED",

  // --- SYSTEM & Holiday ---
  HOLIDAY_CREATED: "HOLIDAY_CREATED",
  STRINGEE_NUMBER_ASSIGNED: "STRINGEE_NUMBER_ASSIGNED",
  SYSTEM_ALERT: "SYSTEM_ALERT",

  // --- INTEGRATIONS ---
  INTEGRATION_LEAD_CREATED: "INTEGRATION_LEAD_CREATED",
  LEAD_WHATSAPP_RECEIVED: "LEAD_WHATSAPP_RECEIVED",
  INTEGRATION_ERROR: "INTEGRATION_ERROR",
} as const;

export type NotificationType =
  (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];

export interface INotification extends Document {
  dedupeKey?: string;
  recipient: Types.ObjectId;
  sender?: Types.ObjectId;
  type: NotificationType;
  title: string;
  message: string;
  entityId?: Types.ObjectId;
  entityType?: string;
  isRead: boolean;
  readAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    dedupeKey: { type: String },
    recipient: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    sender: { type: Schema.Types.ObjectId, ref: "User" },
    type: {
      type: String,
      enum: Object.values(NOTIFICATION_TYPES),
      required: true,
    },
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    entityId: { type: Schema.Types.ObjectId },
    entityType: { type: String },
    isRead: { type: Boolean, default: false, index: true },
    readAt: { type: Date },
  },
  { timestamps: true },
);

notificationSchema.index({ recipient: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });

export const Notification: Model<INotification> =
  mongoose.models.Notification ||
  mongoose.model<INotification>("Notification", notificationSchema);
