import { Router, type Request } from "express";
import rateLimit from "express-rate-limit";
import { Types } from "mongoose";
import { z } from "zod";
import { authenticate } from "../middleware/auth.middleware.js";
import { ChatGroup, ChatMessage } from "../models/Chat.js";
import { User } from "../models/User.js";
import { AppError } from "../utils/AppError.js";
import { inChatScope, managesChat, mayReadChat, type ChatOwner } from "../services/chatAccess.js";

const router = Router();
router.use(authenticate);
const objectId = z.string().regex(/^[a-f\d]{24}$/i);
const groupInput = z.object({
  name: z.string().trim().min(1).max(80),
  memberIds: z.array(objectId).max(300).transform(ids => [...new Set(ids)]),
});
const actor = (req: Request) => {
  if (!req.user) throw new AppError("Authentication required", 401);
  return req.user;
};
const requireAdmin = (req: Request) => {
  const user = actor(req);
  if (!managesChat(user)) throw new AppError("Only Admin or Head can manage groups", 403, "CHAT_MANAGE_FORBIDDEN");
  return user;
};
const ownerShape = (owner: { _id: unknown; role: string; branches: unknown[]; isActive: boolean }): ChatOwner => ({
  id: String(owner._id), role: owner.role, branches: owner.branches.map(String), isActive: owner.isActive,
});
const authorizedGroup = async (req: Request, management = false) => {
  const user = management ? requireAdmin(req) : actor(req);
  const id = objectId.parse(req.params.groupId);
  const group = await ChatGroup.findById(id).lean();
  const owner = group && await User.findById(group.ownerId).select("role branches isActive").lean();
  if (!group || !owner || !mayReadChat(ownerShape(owner), user, group.memberIds.map(String)) ||
      (management && String(group.ownerId) !== user.id)) {
    // Do not reveal whether a different employee's group exists.
    throw new AppError("Group unavailable or access removed", 404, "CHAT_ACCESS_REMOVED");
  }
  return group;
};
const validateMembers = async (req: Request, ids: string[]) => {
  const user = requireAdmin(req);
  const members = await User.find({ _id: { $in: ids }, isActive: true, role: { $in: ["manager", "employee"] } })
    .select("role branches isActive").lean();
  const owner: ChatOwner = { ...user, isActive: true };
  if (members.length !== ids.length || members.some(member => !inChatScope(owner, {
    id: String(member._id), role: member.role, branches: member.branches.map(String),
  }))) throw new AppError("Select active employees/managers from your own branches", 400, "CHAT_INVALID_MEMBERS");
};

router.get("/candidates", async (req, res) => {
  const user = requireAdmin(req);
  const query = z.object({ search: z.string().trim().max(80).default("") }).parse(req.query);
  const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const members = await User.find({
    isActive: true, role: { $in: ["employee", "manager"] },
    ...(user.role === "head" ? {} : { branches: { $in: user.branches } }),
    ...(escaped ? { name: { $regex: escaped, $options: "i" } } : {}),
  }).select("_id name role").sort({ name: 1 }).limit(201).lean();
  res.json({ success: true, data: members.slice(0, 200), hasMore: members.length > 200 });
});

router.get("/groups", async (req, res) => {
  const user = actor(req);
  const groups = await ChatGroup.find({ $or: [{ ownerId: user.id }, { memberIds: user.id }] })
    .sort({ createdAt: -1 }).limit(200).lean();
  const owners = await User.find({ _id: { $in: groups.map(group => group.ownerId) } })
    .select("role branches isActive").lean();
  const ownerMap = new Map(owners.map(owner => [String(owner._id), ownerShape(owner)]));
  const data = groups.filter(group => {
    const owner = ownerMap.get(String(group.ownerId));
    return owner && mayReadChat(owner, user, group.memberIds.map(String));
  }).map(group => ({
    _id: group._id, name: group.name, version: group.version,
    canManage: String(group.ownerId) === user.id && managesChat(user),
    memberCount: group.memberIds.length + 1,
    memberIds: String(group.ownerId) === user.id ? group.memberIds : undefined,
  }));
  res.set("Cache-Control", "no-store").json({ success: true, data });
});

router.post("/groups", async (req, res) => {
  const user = requireAdmin(req);
  const input = groupInput.parse(req.body);
  await validateMembers(req, input.memberIds);
  if (await ChatGroup.countDocuments({ ownerId: user.id }) >= 100) {
    throw new AppError("Maximum 100 groups per admin", 400, "CHAT_GROUP_LIMIT");
  }
  const group = await ChatGroup.create({ ...input, ownerId: user.id });
  res.status(201).json({ success: true, data: { _id: group._id } });
});

router.put("/groups/:groupId", async (req, res) => {
  const group = await authorizedGroup(req, true);
  const input = groupInput.extend({ version: z.number().int().min(0) }).parse(req.body);
  await validateMembers(req, input.memberIds);
  const result = await ChatGroup.updateOne({ _id: group._id, ownerId: actor(req).id, version: input.version }, {
    $set: { name: input.name, memberIds: input.memberIds.map(id => new Types.ObjectId(id)) }, $inc: { version: 1 },
  });
  if (!result.modifiedCount) throw new AppError("Group changed. Refresh and try again", 409, "CHAT_VERSION_CONFLICT");
  res.json({ success: true });
});

router.get("/groups/:groupId/members", async (req, res) => {
  const group = await authorizedGroup(req, true);
  const members = await User.find({ _id: { $in: group.memberIds } }).select("_id name role").lean();
  res.set("Cache-Control", "no-store").json({ success: true, data: members });
});

router.get("/groups/:groupId/messages", async (req, res) => {
  const group = await authorizedGroup(req);
  const query = z.object({ before: objectId.optional() }).parse(req.query);
  const messages = await ChatMessage.find({ groupId: group._id,
    ...(query.before ? { _id: { $lt: new Types.ObjectId(query.before) } } : {}),
  }).select("_id senderId senderName text createdAt").sort({ _id: -1 }).limit(51).lean();
  const hasMore = messages.length > 50;
  const page = messages.slice(0, 50);
  res.set("Cache-Control", "no-store").json({ success: true, data: page.reverse(), hasMore });
});

router.post("/groups/:groupId/messages", rateLimit({
  windowMs: 60_000, limit: 30,
  keyGenerator: req => actor(req).id,
  message: { success: false, message: "Please wait before sending more messages" },
}), async (req, res) => {
  const group = await authorizedGroup(req);
  const user = actor(req);
  const input = z.object({ text: z.string().trim().min(1).max(4000), clientId: z.string().uuid() }).parse(req.body);
  // A retried network request cannot create duplicate messages.
  const filter = { groupId: group._id, senderId: new Types.ObjectId(user.id), clientId: input.clientId };
  let message;
  try {
    message = await ChatMessage.findOneAndUpdate(filter, { $setOnInsert: {
      ...filter, text: input.text, senderName: user.name,
    } }, { upsert: true, new: true, runValidators: true });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    message = await ChatMessage.findOne(filter);
  }
  res.status(201).json({ success: true, data: { _id: message?._id } });
});

export default router;
