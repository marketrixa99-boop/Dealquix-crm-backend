import mongoose from "mongoose";
import { env } from "./env.js";

// Shared by concurrent requests in one warm function, not across instances.
let pendingConnection: Promise<void> | undefined;

export const connectDatabase = async (): Promise<void> => {
  if (mongoose.connection.readyState === 1) return;

  if (!pendingConnection) {
    pendingConnection = mongoose.connect(env.mongoUri, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    }).then(() => {
      console.log("MongoDB connected successfully");
    }).finally(() => {
      // A rejected connection must not poison every future invocation.
      pendingConnection = undefined;
    });
  }

  // Let the caller handle failure. Never kill other in-flight requests.
  await pendingConnection;
};
