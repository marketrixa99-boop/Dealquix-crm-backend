import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';

// Isolated fake data only. No production credentials or database connection.
process.env.MONGO_URI = 'mongodb://127.0.0.1/chat-test-not-connected';
process.env.JWT_SECRET = 'isolated-chat-test-only';
const { User } = await import('../dist/models/User.js');
const { ChatGroup, ChatMessage } = await import('../dist/models/Chat.js');
const { default: router } = await import('../dist/routes/chat.routes.js');
const { inChatScope, mayReadChat } = await import('../dist/services/chatAccess.js');
const id = n => new Types.ObjectId(n.toString(16).padStart(24, '0'));
const a = String(id(100)), b = String(id(101));
const users = [
  { _id: id(1), name: 'Admin', role: 'admin', branches: [a], isActive: true },
  { _id: id(2), name: 'Employee', role: 'employee', branches: [a], isActive: true },
  { _id: id(3), name: 'Other branch', role: 'employee', branches: [b], isActive: true },
  { _id: id(4), name: 'Second admin', role: 'admin', branches: [a], isActive: true },
  { _id: id(5), name: 'Manager', role: 'manager', branches: [a], isActive: true },
];
const group = { _id: id(10), name: 'Sales', ownerId: id(1), memberIds: [id(2)], version: 0 };
const messages = [{ _id: id(30), groupId: id(10), senderId: id(1), senderName: 'Admin', text: 'Hello', createdAt: new Date().toISOString() }];
const chain = value => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => value });
User.findById = userId => chain(users.find(user => String(user._id) === String(userId)) ?? null);
User.find = filter => chain(users.filter(user =>
  (!filter._id || filter._id.$in.map(String).includes(String(user._id))) &&
  (!filter.role || filter.role.$in.includes(user.role)) &&
  (filter.isActive === undefined || user.isActive === filter.isActive) &&
  (!filter.branches || user.branches.some(branch => filter.branches.$in.includes(branch))) &&
  (!filter.name || new RegExp(filter.name.$regex, 'i').test(user.name))
));
ChatGroup.findById = groupId => chain(String(groupId) === String(group._id) ? { ...group, memberIds: [...group.memberIds] } : null);
ChatGroup.find = filter => chain(filter.$or.some(condition =>
  condition.ownerId === String(group.ownerId) || group.memberIds.map(String).includes(condition.memberIds)
) ? [{ ...group }] : []);
ChatGroup.countDocuments = async () => 1;
ChatGroup.create = async input => ({ ...input, _id: id(20) });
ChatGroup.updateOne = async (filter, change) => {
  if (filter.version !== group.version) return { modifiedCount: 0 };
  Object.assign(group, change.$set); group.version++; return { modifiedCount: 1 };
};
ChatMessage.find = filter => chain(messages.filter(message => String(message.groupId) === String(filter.groupId)));
ChatMessage.findOneAndUpdate = async (filter, change) => {
  const match = messages.find(message => message.clientId === filter.clientId && String(message.senderId) === String(filter.senderId));
  if (match) return match;
  const message = { ...change.$setOnInsert, _id: id(30 + messages.length), createdAt: new Date().toISOString() };
  messages.push(message); return message;
};
const app = express(); app.use(express.json()); app.use('/chat', router);
app.use((error, _req, res, _next) => res.status(error.statusCode ?? (error.name === 'ZodError' ? 400 : 500)).json({ message: error.message }));
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const request = async (user, path, method = 'GET', body) => {
  const token = user ? jwt.sign({ sub: String(id(user)) }, process.env.JWT_SECRET) : '';
  const response = await fetch(`http://127.0.0.1:${server.address().port}/chat${path}`, {
    method, headers: { ...(user ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
};
test('group chat authorization and request contracts', async t => {
  try {
    await t.test('unauthenticated requests denied', async () => assert.equal((await request(null, '/groups')).status, 401));
    await t.test('employee sees assigned group only', async () => {
      assert.equal((await request(2, '/groups')).body.data.length, 1);
      assert.equal((await request(3, '/groups')).body.data.length, 0);
      assert.equal((await request(4, '/groups')).body.data.length, 0);
    });
    await t.test('membership and branch scope enforced for reads and sends', async () => {
      assert.equal((await request(2, `/groups/${group._id}/messages`)).status, 200);
      assert.equal((await request(3, `/groups/${group._id}/messages`)).status, 404);
      assert.equal((await request(3, `/groups/${group._id}/messages`, 'POST', { text: 'No', clientId: crypto.randomUUID() })).status, 404);
      assert.equal(messages.length, 1);
    });
    await t.test('only owning Admin manages membership', async () => {
      const input = { name: 'Sales', memberIds: [String(id(2))], version: 0 };
      assert.equal((await request(2, '/groups', 'POST', input)).status, 403);
      assert.equal((await request(4, `/groups/${group._id}`, 'PUT', input)).status, 404);
      assert.equal((await request(2, '/candidates')).status, 403);
    });
    await t.test('out-of-branch and elevated-role invitations denied', async () => {
      assert.equal((await request(1, '/groups', 'POST', { name: 'Bad', memberIds: [String(id(3))] })).status, 400);
      assert.equal((await request(1, '/groups', 'POST', { name: 'Bad', memberIds: [String(id(4))] })).status, 400);
      assert.equal((await request(1, '/groups', 'POST', { name: 'Good', memberIds: [String(id(5))] })).status, 201);
    });
    await t.test('invalid ids, whitespace and overlong messages rejected', async () => {
      assert.equal((await request(2, '/groups/invalid/messages')).status, 400);
      for (const text of ['  ', 'a'.repeat(4001)]) assert.equal((await request(2, `/groups/${group._id}/messages`, 'POST', { text, clientId: crypto.randomUUID() })).status, 400);
    });
    await t.test('idempotent sending uses authenticated sender, not spoofed fields', async () => {
      const input = { text: 'Hi', clientId: crypto.randomUUID(), senderId: String(id(1)), senderName: 'Spoof' };
      const first = await request(2, `/groups/${group._id}/messages`, 'POST', input);
      const second = await request(2, `/groups/${group._id}/messages`, 'POST', input);
      assert.equal(first.status, 201); assert.equal(first.body.data._id, second.body.data._id);
      assert.equal(messages.length, 2); assert.equal(messages[1].senderName, 'Employee');
    });
    await t.test('membership removal immediately revokes read and send access', async () => {
      assert.equal((await request(1, `/groups/${group._id}`, 'PUT', { name: 'Sales', memberIds: [], version: 0 })).status, 200);
      assert.equal((await request(2, '/groups')).body.data.length, 0);
      assert.equal((await request(2, `/groups/${group._id}/messages`)).status, 404);
      assert.equal((await request(2, `/groups/${group._id}/messages`, 'POST', { text: 'Denied', clientId: crypto.randomUUID() })).status, 404);
      assert.equal((await request(1, `/groups/${group._id}`, 'PUT', { name: 'Sales', memberIds: [], version: 0 })).status, 409);
    });
    await t.test('inactive owner or moved branch removes access', () => {
      const owner = { id: 'owner', role: 'admin', branches: [a], isActive: true };
      const member = { id: 'member', role: 'employee', branches: [a] };
      assert.equal(mayReadChat(owner, member, ['member']), true);
      assert.equal(mayReadChat(owner, { ...member, branches: [b] }, ['member']), false);
      assert.equal(mayReadChat({ ...owner, isActive: false }, member, ['member']), false);
      assert.equal(inChatScope({ ...owner, role: 'employee' }, member), false);
      assert.equal(mayReadChat({ ...owner, role: 'head' }, member, []), false);
    });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
