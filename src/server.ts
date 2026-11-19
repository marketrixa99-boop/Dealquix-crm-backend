import app from "./app.js";
import { connectDatabase } from "./config/database.js";
import { env } from "./config/env.js";
import { startFollowUpReminders } from "./services/followup-reminder.service.js";

const startServer = async (): Promise<void> => {
  try {
    await connectDatabase();
    // Ensure the cross-instance deduplication constraint exists before sweeping.
    const { Notification } = await import("./models/Notification.js");
    await Notification.collection.createIndex({ dedupeKey: 1 }, { unique: true, sparse: true });
    const { TeamChatMessage } = await import("./models/TeamChatMessage.js");
    await TeamChatMessage.collection.createIndex({ branch: 1, sender: 1, clientMessageId: 1 }, { unique: true });
    // Calling must not start before extension ownership and request deduplication
    // are enforced by the database, including on first deployment.
    const { User } = await import("./models/User.js");
    await User.collection.createIndex({ dialixaExtension: 1 }, {
      unique: true, partialFilterExpression: { dialixaExtension: { $type: "string" } },
    });
    const { CallLog } = await import("./models/CallLog.js");
    await CallLog.collection.createIndex({ callId: 1 }, { unique: true });
    startFollowUpReminders();

    app.listen(env.port, () => {
      console.log(
        `CRM API running on http://localhost:${env.port}`
      );
    });
  } catch (error) {
    console.error("Failed to start server:", error);

    process.exit(1);
  }
};

startServer();
