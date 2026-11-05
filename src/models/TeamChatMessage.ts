import { Schema, model } from "mongoose";

const schema = new Schema(
  {
    branch: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    sender: { type: Schema.Types.ObjectId, ref: "User", required: true },
    text: { type: String, required: true, trim: true, maxlength: 2000 },
    clientMessageId: { type: String, required: true, maxlength: 36 },
  },
  { timestamps: true },
);
schema.index({ branch: 1, _id: -1 });
schema.index({ branch: 1, sender: 1, clientMessageId: 1 }, { unique: true });
export const TeamChatMessage = model("TeamChatMessage", schema);
