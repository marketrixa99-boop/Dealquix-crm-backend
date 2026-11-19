import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import axios from "axios";
import { randomUUID } from "node:crypto";
process.env.MONGO_URI = "mongodb://127.0.0.1/isolated-dialixa-test";
process.env.JWT_SECRET = "dialixa-test-secret-only";
process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
const { User } = await import("../dist/models/User.js");
const { Lead } = await import("../dist/models/Lead.js");
const { CallLog } = await import("../dist/models/CallLog.js");
const { DialixaConfig, DialixaCallLock, DialixaRateBucket } = await import("../dist/models/DialixaConfig.js");
const { encryptSecret, decryptSecret } = await import("../dist/utils/crypto.js");
const { startDialixaCall, getDialixaSession } = await import("../dist/services/dialixa.service.js");
const { getSettings, updateSettings, updateAgent } = await import("../dist/controllers/dialixa.controller.js");
const { dialixaCallInput, normalizeDialixaNumber, validateDialixaBaseUrl } = await import("../dist/validators/dialixa.validator.js");
const { default: routes } = await import("../dist/routes/dialer.routes.js");
const { errorHandler } = await import("../dist/middleware/error.middleware.js");
const uid = "507f1f77bcf86cd799439011", branch = "507f1f77bcf86cd799439012", lid = "507f1f77bcf86cd799439013";
const user = (role = "employee", branches = [branch]) => ({ id: uid, name: "Agent", email: "agent@example.test", role, branches, branchId: branches });
const secret = "test-dialixa-key-never-return-this";
function chain(value) {
  const q = {};
  for (const key of ["select", "populate", "sort", "skip", "limit"]) q[key] = () => q;
  q.lean = async () => value;
  q.then = (resolve, reject) => Promise.resolve(value).then(resolve, reject);
  return q;
}
function fixture(t, { role = "employee", enabled = true, assigned = true } = {}) {
  const agent = { _id: uid, ...user(role), isActive: true, dialerEnabled: assigned, dialixaExtension: assigned ? "41857" : undefined };
  const config = { enabled, keyConfigured: true, apiBaseUrl: "https://dev.voxentroconsulting.com", apiKeyEncrypted: encryptSecret(secret) };
  const lead = { _id: lid, name: "Test Customer", phoneCountryCode: "+91", phone: "9876543210", branch, assignedTo: uid, isDeleted: false };
  const logs = new Map();
  t.mock.method(User, "findById", () => chain(agent));
  t.mock.method(DialixaConfig, "findById", () => chain(config));
  t.mock.method(Lead, "findOne", () => chain(lead));
  t.mock.method(CallLog, "findOne", ({ callId }) => chain(logs.get(callId) || null));
  t.mock.method(CallLog, "create", async (log) => { assert(!logs.has(log.callId)); logs.set(log.callId, { ...log }); return log; });
  t.mock.method(CallLog, "updateOne", async ({ callId }, update) => { Object.assign(logs.get(callId), update.$set); return {}; });
  t.mock.method(DialixaCallLock, "findOneAndUpdate", async () => ({}));
  t.mock.method(DialixaCallLock, "deleteOne", async () => ({}));
  t.mock.method(DialixaRateBucket, "findOneAndUpdate", async () => ({}));
  const outbound = t.mock.method(axios, "post", async () => ({ status: 200, data: { sensitiveProviderBody: secret } }));
  return { agent, config, lead, logs, outbound, input: { requestId: randomUUID(), leadId: lid } };
}
function response() {
  const res = { body: null };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test("validation rejects client extensions, invalid numbers, untrusted hosts and redirects", () => {
  assert(!dialixaCallInput.safeParse({ requestId: randomUUID(), number: "9876543210", extension: "99999" }).success);
  assert.equal(normalizeDialixaNumber("+91 (98765) 43210"), "919876543210");
  for (const number of ["123", "0000000000", "98765#43210", "9e123456789"]) assert.throws(() => normalizeDialixaNumber(number));
  for (const url of ["http://dev.voxentroconsulting.com", "https://127.0.0.1", "https://dev.voxentroconsulting.com.evil.test", "https://user:pass@dev.voxentroconsulting.com", "https://dev.voxentroconsulting.com/api", "https://dev.voxentroconsulting.com?key=x"]) assert.throws(() => validateDialixaBaseUrl(url));
  assert.equal(validateDialixaBaseUrl("https://dev.voxentroconsulting.com/"), "https://dev.voxentroconsulting.com");
});

test("HTTP routes require authentication, deny settings/agent access to employees and retire Stringee", async (t) => {
  fixture(t);
  t.mock.method(console, "error", () => {});
  const app = express(); app.use(express.json()); app.use("/dialer", routes); app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}/dialer`;
  const headers = { Authorization: "Bearer " + jwt.sign({ sub: uid }, process.env.JWT_SECRET), "Content-Type": "application/json" };
  try {
    assert.equal((await fetch(url + "/session")).status, 401);
    assert.equal((await fetch(url + "/settings", { headers })).status, 403);
    assert.equal((await fetch(url + "/agents", { headers })).status, 403);
    assert.equal((await fetch(url + "/agents/" + uid, { headers, method: "PATCH", body: JSON.stringify({ extension: "12345", enabled: true }) })).status, 403);
    assert.equal((await fetch(url + "/token", { headers })).status, 410);
    assert.equal((await fetch(url + "/answer-url", { method: "POST" })).status, 410);
    assert.equal((await fetch(url + "/click-to-call", { headers, method: "POST", body: JSON.stringify({ requestId: randomUUID(), number: "9876543210", extension: "99999" }) })).status, 400);
    const session = await (await fetch(url + "/session", { headers })).json();
    assert(session.data.canCall); assert.equal(session.data.extension, "41857");
    assert(!JSON.stringify(session).includes(secret));
  } finally { await new Promise((r) => server.close(r)); }
});

test("calling fails closed without account setup, enabled extension, branch or assigned lead", async (t) => {
  const f = fixture(t, { enabled: false });
  await assert.rejects(startDialixaCall(user(), f.input), { statusCode: 503 });
  f.config.enabled = true; f.agent.dialerEnabled = false;
  await assert.rejects(startDialixaCall(user(), f.input), { statusCode: 403 });
  await assert.rejects(startDialixaCall(user(), { requestId: randomUUID(), number: "9876543210" }), { statusCode: 403 });
  await assert.rejects(startDialixaCall(user("admin", []), { requestId: randomUUID(), number: "9876543210" }), { statusCode: 403 });
  f.agent.dialerEnabled = true;
  t.mock.method(Lead, "findOne", (filter) => {
    assert.equal(String(filter.assignedTo), uid); assert.deepEqual(filter.branch.$in.map(String), [branch]);
    assert.equal(filter.isDeleted, false); return chain(null);
  });
  await assert.rejects(startDialixaCall(user(), f.input), { statusCode: 404 });
  assert.equal(f.outbound.mock.callCount(), 0);
});

test("call uses server-owned extension and lead number, accepts only a request, and deduplicates replays", async (t) => {
  const f = fixture(t);
  const result = await startDialixaCall(user(), f.input);
  assert.equal(result.status, "requested"); assert(!JSON.stringify(result).includes(secret));
  const [url, payload, options] = f.outbound.mock.calls[0].arguments;
  assert.equal(url, "https://dev.voxentroconsulting.com/api/v1/public/click-to-call");
  assert.deepEqual(payload, { extension: "41857", number: "919876543210", contactName: "Test Customer" });
  assert.equal(options.headers["X-API-Key"], secret); assert.equal(options.maxRedirects, 0); assert.equal(options.timeout, 15000);
  const record = [...f.logs.values()][0];
  assert.equal(record.caller, uid); assert.equal(record.branch, branch); assert.equal(record.callStatus, "requested");
  assert.equal(record.duration, 0); assert.equal(record.recordingUrl, undefined);
  assert.equal((await startDialixaCall(user(), f.input)).accepted, true);
  assert.equal(f.outbound.mock.callCount(), 1);
  await assert.rejects(startDialixaCall(user(), { ...f.input, number: "919999999999" }), { statusCode: 400 });
});

test("same request ID with another destination is rejected", async (t) => {
  const f = fixture(t, { role: "head" });
  const input = { requestId: randomUUID(), number: "919876543210" };
  await startDialixaCall(user("head"), input);
  await assert.rejects(startDialixaCall(user("head"), { ...input, number: "919876543211" }), { statusCode: 409 });
  assert.equal(f.outbound.mock.callCount(), 1);
});

test("provider errors are actionable, redact bodies, and never return provider 401 as CRM 401", async (t) => {
  for (const [upstream, expected] of [[400, 400], [401, 502], [403, 403], [404, 400], [429, 429], [500, 504], [302, 504]]) {
    await t.test(String(upstream), async (t) => {
      const f = fixture(t);
      f.outbound.mock.mockImplementation(async () => ({ status: upstream, data: { message: secret } }));
      await assert.rejects(startDialixaCall(user(), f.input), (error) => error.statusCode === expected && !error.message.includes(secret));
      assert.equal([...f.logs.values()][0].callStatus, upstream >= 500 || upstream === 302 ? "unknown" : "failed");
      assert.equal(f.outbound.mock.callCount(), 1);
    });
  }
});

test("timeout stays unknown and never retries upstream on replay", async (t) => {
  const f = fixture(t);
  f.outbound.mock.mockImplementation(async () => { throw new Error(secret); });
  await assert.rejects(startDialixaCall(user(), f.input), { statusCode: 504, code: "DIALIXA_OUTCOME_UNKNOWN" });
  await assert.rejects(startDialixaCall(user(), f.input), { statusCode: 409 });
  assert.equal([...f.logs.values()][0].callStatus, "unknown"); assert.equal(f.outbound.mock.callCount(), 1);
});

test("atomic lease prevents concurrent requests with different IDs, and rate limit stops outbound calls", async (t) => {
  const f = fixture(t);
  let locked = false, resolveProvider, enteredProvider;
  const entered = new Promise((r) => { enteredProvider = r; });
  t.mock.method(DialixaCallLock, "findOneAndUpdate", async (filter, update, options) => {
    assert.equal(filter._id, uid); assert(filter.expiresAt.$lte instanceof Date); assert(options.upsert);
    assert(update.$set.expiresAt > filter.expiresAt.$lte);
    if (locked) throw { code: 11000 }; locked = true; return {};
  });
  f.outbound.mock.mockImplementation(() => { enteredProvider(); return new Promise((r) => { resolveProvider = r; }); });
  const first = startDialixaCall(user(), f.input); await entered;
  await assert.rejects(startDialixaCall(user(), { ...f.input, requestId: randomUUID() }), { statusCode: 429 });
  resolveProvider({ status: 200 }); await first;
  assert.equal(f.outbound.mock.callCount(), 1);
  locked = false;
  t.mock.method(DialixaRateBucket, "findOneAndUpdate", async (filter, update, options) => {
    assert.equal(filter.count.$lt, 60); assert.equal(update.$inc.count, 1); assert(options.upsert);
    throw { code: 11000 };
  });
  await assert.rejects(startDialixaCall(user(), { ...f.input, requestId: randomUUID() }), { statusCode: 429 });
  assert.equal(f.outbound.mock.callCount(), 1);
});

test("Head settings encrypt the key and never echo it; changing the host requires a fresh key", async (t) => {
  const f = fixture(t, { role: "head" });
  let saved;
  t.mock.method(DialixaConfig, "findOneAndUpdate", async (_filter, update) => { saved = update.$set; Object.assign(f.config, saved); return f.config; });
  const req = { user: user("head"), body: { enabled: true, apiBaseUrl: "https://dev.voxentroconsulting.com", apiKey: secret } };
  const res = response(); await updateSettings(req, res);
  assert.notEqual(saved.apiKeyEncrypted, secret); assert.equal(decryptSecret(saved.apiKeyEncrypted), secret);
  assert(res.body.data.keyConfigured); assert(!JSON.stringify(res.body).includes(secret));
  const read = response(); await getSettings(req, read); assert(!JSON.stringify(read.body).includes("apiKeyEncrypted"));
  await assert.rejects(updateSettings({ ...req, body: { enabled: true, apiBaseUrl: "https://prod.voxentroconsulting.com" } }, response()), { statusCode: 400 });
});

test("agent updates are scoped, enforce unique extensions and can remove access", async (t) => {
  fixture(t, { role: "admin" });
  let scoped, update;
  t.mock.method(User, "findOne", (filter) => { scoped = filter; return chain({ isActive: true }); });
  t.mock.method(User, "findOneAndUpdate", (filter, input) => { update = input; return chain({ name: "Test", dialerEnabled: false }); });
  await updateAgent({ user: user("admin"), params: { userId: uid }, body: { extension: null, enabled: false } }, response());
  assert(scoped.$or); assert.equal(scoped.$or[0]._id, uid);
  assert.deepEqual(scoped.$or[1].role.$in, ["manager", "employee"]);
  assert.deepEqual(scoped.$or[1].branches.$in.map(String), [branch]);
  assert.deepEqual(scoped.$or[1].branches.$not.$elemMatch.$nin.map(String), [branch]);
  assert.equal(update.$unset.dialixaExtension, 1); assert.equal(update.$set.dialerEnabled, false);
  t.mock.method(User, "findOneAndUpdate", () => { throw { code: 11000 }; });
  await assert.rejects(updateAgent({ user: user("head"), params: { userId: uid }, body: { extension: "41857", enabled: true } }, response()), { statusCode: 409 });
});

test("call history by ID is scoped and Head retains global lead history", async (t) => {
  const f = fixture(t);
  let logFilter, leadFilter;
  t.mock.method(CallLog, "findOne", (filter) => { logFilter = filter; return chain(null); });
  t.mock.method(CallLog, "find", (filter) => { logFilter = filter; return chain([]); });
  t.mock.method(Lead, "findOne", (filter) => { leadFilter = filter; return chain(f.lead); });
  const app = express(); app.use("/dialer", routes); app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}/dialer`;
  const headers = { Authorization: "Bearer " + jwt.sign({ sub: uid }, process.env.JWT_SECRET) };
  try {
    assert.equal((await fetch(url + "/logs/" + lid, { headers })).status, 404);
    assert.equal(String(logFilter.caller), uid); assert.deepEqual(logFilter.branch.$in.map(String), [branch]);
    f.agent.role = "head"; f.agent.branches = [];
    assert.equal((await fetch(url + "/lead/" + lid, { headers })).status, 200);
    assert.equal(leadFilter.branch, undefined); assert.equal(logFilter.branch, undefined); assert.equal(logFilter.caller, undefined);
  } finally { await new Promise((r) => server.close(r)); }
});
