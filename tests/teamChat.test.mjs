import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
process.env.MONGO_URI = "mongodb://127.0.0.1/isolated-chat-test";
process.env.JWT_SECRET = "isolated-chat-test-secret";
const { User } = await import("../dist/models/User.js");
const { Branch } = await import("../dist/models/Branch.js");
const { TeamChatMessage } = await import("../dist/models/TeamChatMessage.js");
const { default: chat, chatMessageInput } =
  await import("../dist/routes/teamChat.routes.js");
const { errorHandler } = await import("../dist/middleware/error.middleware.js");
const uid = "507f1f77bcf86cd799439011",
  branch = "507f1f77bcf86cd799439012",
  other = "507f1f77bcf86cd799439013";
const mid = "0d252bdb-fabd-44b9-9c67-fc1606f2448c";
const chain = (value) => {
  const q = {};
  for (const key of ["select", "sort", "limit", "populate"]) q[key] = () => q;
  q.lean = async () => value;
  return q;
};
test("chat rejects empty, oversized and forged sender/branch input", () => {
  assert(
    chatMessageInput.safeParse({ text: " hello ", clientMessageId: mid })
      .success,
  );
  for (const body of [
    { text: " ", clientMessageId: mid },
    { text: "x".repeat(2001), clientMessageId: mid },
    { text: "test", clientMessageId: "bad" },
    { text: "test", clientMessageId: mid, sender: uid },
    { text: "test", clientMessageId: mid, branch: other },
  ])
    assert(!chatMessageInput.safeParse(body).success);
});
test("chat routes enforce current branch membership, chronological pages and idempotent sends", async (t) => {
  let role = "employee",
    active = true,
    memberships = [branch],
    reads = 0,
    messages = [];
  t.mock.method(User, "findById", () =>
    chain({
      _id: uid,
      name: "Tester",
      email: "t@example.com",
      role,
      branches: memberships,
      isActive: true,
    }),
  );
  t.mock.method(Branch, "exists", async () =>
    active ? { _id: branch } : null,
  );
  t.mock.method(TeamChatMessage, "find", (filter) => {
    reads++;
    assert.equal(filter.branch, branch);
    return chain(messages);
  });
  const saved = new Map();
  t.mock.method(TeamChatMessage, "findOneAndUpdate", (key, update, options) => {
    assert.equal(key.sender, uid);
    assert.equal(key.branch, branch);
    assert(options.upsert);
    const k = JSON.stringify(key);
    if (!saved.has(k))
      saved.set(k, {
        _id: uid,
        ...update.$setOnInsert,
        createdAt: new Date(),
        sender: { _id: uid, name: "Tester" },
      });
    return chain(saved.get(k));
  });
  const app = express();
  app.use(express.json());
  app.use("/chat", chat);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/chat`;
  const headers = {
    Authorization: "Bearer " + jwt.sign({ sub: uid }, process.env.JWT_SECRET),
    "Content-Type": "application/json",
  };
  const post = (body) =>
    fetch(`${base}/${branch}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await fetch(`${base}/${branch}/messages`)).status, 401);
    assert.equal(
      (await fetch(`${base}/${other}/messages`, { headers })).status,
      403,
    );
    assert.equal(reads, 0);
    memberships = [];
    assert.equal(
      (await fetch(`${base}/${branch}/messages`, { headers })).status,
      403,
    );
    memberships = [branch];
    active = false;
    assert.equal(
      (await fetch(`${base}/${branch}/messages`, { headers })).status,
      404,
    );
    active = true;
    assert.equal(
      (await fetch(`${base}/${branch}/messages?before=invalid`, { headers }))
        .status,
      400,
    );
    messages = Array.from({ length: 51 }, (_, i) => ({
      _id: (51 - i).toString(16).padStart(24, "0"),
      text: "Message",
      sender: { _id: uid, name: "Tester" },
    }));
    const page = await (
      await fetch(`${base}/${branch}/messages`, { headers })
    ).json();
    assert.equal(page.data.rows.length, 50);
    assert.equal(page.data.rows[0]._id, "000000000000000000000002");
    assert.equal(page.data.nextBefore, page.data.rows[0]._id);
    assert.equal(page.data.rows.at(-1)._id, "000000000000000000000033");
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await post({ text: "Hello", clientMessageId: mid })).status,
        201,
      );
    assert.equal(saved.size, 1);
    assert.equal(
      (await post({ text: "Changed message", clientMessageId: mid })).status,
      409,
    );
    assert.equal(
      (await post({ text: "Hello", clientMessageId: mid, sender: other }))
        .status,
      400,
    );
    role = "head";
    memberships = [];
    messages = [];
    assert.equal(
      (await fetch(`${base}/${branch}/messages`, { headers })).status,
      200,
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});
