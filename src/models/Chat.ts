import { Schema, model } from "mongoose";

const groupSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  memberIds: [{ type: Schema.Types.ObjectId, ref: "User" }],
  version: { type: Number, default: 0, required: true },
}, { timestamps: true });
groupSchema.index({ ownerId: 1 });
groupSchema.index({ memberIds: 1 });
export const ChatGroup = model("ChatGroup", groupSchema);

const messageSchema = new Schema({
  groupId: { type: Schema.Types.ObjectId, ref: "ChatGroup", required: true },
  senderId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  senderName: { type: String, required: true },
  text: { type: String, required: true, maxlength: 4000 },
  clientId: { type: String, required: true, maxlength: 64 },
}, { timestamps: true });
messageSchema.index({ groupId: 1, _id: -1 });
messageSchema.index({ groupId: 1, senderId: 1, clientId: 1 }, { unique: true });
export const ChatMessage = model("ChatMessage", messageSchema);
