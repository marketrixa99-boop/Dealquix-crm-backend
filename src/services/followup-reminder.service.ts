import { LeadFollowUp } from "../models/LeadFollowUp.js";
import { Lead } from "../models/Lead.js";
import { User } from "../models/User.js";
import { Notification } from "../models/Notification.js";

// Durable in-app reminders. Unique notification keys make overlapping instances
// and restarts safe. Do not send external WhatsApp/SMS messages from this worker.
export async function runFollowUpReminders(now = new Date()) {
  for (const stage of ["due", "overdue"] as const) {
    const marker = stage === "due" ? "reminderSentAt" : "escalatedAt";
    const cutoff = stage === "due" ? now : new Date(now.getTime() - 30 * 60000);
    const pending = await LeadFollowUp.find({
      status: "PENDING",
      scheduledAt: { $lte: cutoff },
      [marker]: { $exists: false },
    })
      .sort({ scheduledAt: 1 })
      .limit(100)
      .lean();
    for (const followup of pending) {
      const lead = await Lead.findOne({
        _id: followup.lead,
        isDeleted: false,
        branch: followup.branch,
        assignedTo: followup.assignedTo,
      })
        .select("name")
        .lean();
      if (lead) {
        const users = await User.find(
          stage === "due"
            ? {
                _id: followup.assignedTo,
                isActive: true,
                branches: followup.branch,
              }
            : {
                isActive: true,
                $or: [
                  { role: "head" },
                  {
                    role: { $in: ["admin", "manager"] },
                    branches: followup.branch,
                  },
                ],
              },
        )
          .select("_id")
          .lean();
        for (const user of users) {
          const dedupeKey = `followup:${followup._id}:${stage}:${user._id}`;
          await Notification.updateOne(
            { dedupeKey },
            {
              $setOnInsert: {
                dedupeKey,
                recipient: user._id,
                type: "SYSTEM_ALERT",
                title:
                  stage === "due"
                    ? "Follow-up due"
                    : "Missed follow-up needs attention",
                message: `${lead.name}: follow-up scheduled for ${followup.scheduledAt.toISOString()}`,
                entityId: followup.lead,
                entityType: "Lead",
                isRead: false,
              },
            },
            { upsert: true },
          );
        }
      }
      await LeadFollowUp.updateOne(
        { _id: followup._id, status: "PENDING" },
        { $set: { [marker]: now } },
      );
    }
  }
}

export function startFollowUpReminders() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runFollowUpReminders();
    } catch {
      console.error(
        "Follow-up reminders failed; next scheduled sweep will retry.",
      );
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => {
    void tick();
  }, 60000);
  timer.unref();
  return () => clearInterval(timer);
}
