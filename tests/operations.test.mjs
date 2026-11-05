import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
process.env.MONGO_URI = "mongodb://127.0.0.1/isolated-operations-test";
process.env.JWT_SECRET = "operations-isolated-test-secret";
const {
  operationsScope,
  queueQuery,
  ticketInput,
  ticketUpdate,
  nextAssignee,
  reportWindow,
} = await import("../dist/validators/operations.validator.js");
const { User } = await import("../dist/models/User.js");
const { Lead } = await import("../dist/models/Lead.js");
const { LeadFollowUp } = await import("../dist/models/LeadFollowUp.js");
const { LeadActivity } = await import("../dist/models/LeadActivity.js");
const { Notification } = await import("../dist/models/Notification.js");
const { SupportTicket } = await import("../dist/models/SupportTicket.js");
const { Branch } = await import("../dist/models/Branch.js");
const { EmployeeProfile } = await import("../dist/models/EmployeeProfile.js");
const { LeadAssignmentHistory } =
  await import("../dist/models/LeadAssignmentHistory.js");
const { runFollowUpReminders } =
  await import("../dist/services/followup-reminder.service.js");
const { default: routes } = await import("../dist/routes/operations.routes.js");
const { errorHandler } = await import("../dist/middleware/error.middleware.js");
const uid = "507f1f77bcf86cd799439011",
  branch = "507f1f77bcf86cd799439012",
  other = "507f1f77bcf86cd799439013",
  lid = "507f1f77bcf86cd799439014";
const user = (role = "employee", branches = [branch]) => ({
  id: uid,
  name: "Test",
  email: "test@example.com",
  role,
  branches,
  branchId: branches,
});
const chain = (value) => {
  const q = {};
  for (const key of ["select", "populate", "sort", "skip", "limit"])
    q[key] = () => q;
  q.lean = async () => value;
  q.then = (resolve, reject) => Promise.resolve(value).then(resolve, reject);
  return q;
};

test("branch and owner scopes fail closed for branchless users and cross-branch access", () => {
  assert.deepEqual(operationsScope(user("head")), {});
  assert.equal(String(operationsScope(user()).assignedTo), uid);
  assert.equal(String(operationsScope(user("employee", [])).assignedTo), uid);
  assert.deepEqual(operationsScope(user("admin", [])).branch, { $in: [] });
  assert.throws(() => operationsScope(user("manager"), other), /access/);
  assert.equal(String(operationsScope(user("head"), other).branch), other);
  assert.equal(
    String(operationsScope(user(), undefined, "caller").caller),
    uid,
  );
});
test("validation bounds batches, dates, ticket fields and optimistic update versions", () => {
  for (const input of [
    { page: 0 },
    { days: 366 },
    { days: -1 },
    { branchId: "$ne" },
  ])
    assert.equal(queueQuery.safeParse(input).success, false);
  const ticket = {
    leadId: lid,
    subject: "Cannot login",
    description: "Please check access",
    category: "login",
  };
  assert(ticketInput.safeParse(ticket).success);
  assert(!ticketInput.safeParse({ ...ticket, branch: other }).success);
  assert(!ticketUpdate.safeParse({ status: "resolved" }).success);
  assert(!ticketUpdate.safeParse({ version: 0 }).success);
  assert(
    !ticketUpdate.safeParse({ version: 0, assignedTo: { $ne: null } }).success,
  );
  assert(ticketUpdate.safeParse({ version: 0, comment: "Checking" }).success);
  assert.equal(
    reportWindow(7, new Date("2026-11-05T10:00:00Z")).$gte.toISOString(),
    "2026-10-29T10:00:00.000Z",
  );
});
test("least-load selection balances repeated assignment and has a deterministic tie break", () => {
  const loads = [
    { id: "b", count: 2 },
    { id: "a", count: 0 },
    { id: "c", count: 0 },
  ];
  const order = [];
  for (let i = 0; i < 5; i++) {
    const selected = nextAssignee(loads);
    order.push(selected.id);
    selected.count++;
  }
  assert.deepEqual(order, ["a", "c", "a", "c", "a"]);
  assert.equal(nextAssignee([]), undefined);
});

test("HTTP routes enforce auth, permissions, current lead visibility and ticket version conflicts", async (t) => {
  let role = "employee";
  t.mock.method(User, "findById", () =>
    chain({ _id: uid, ...user(role), isActive: true }),
  );
  const app = express();
  app.use(express.json());
  app.use("/operations", routes);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}/operations`;
  const headers = {
    Authorization: "Bearer " + jwt.sign({ sub: uid }, process.env.JWT_SECRET),
    "Content-Type": "application/json",
  };
  const request = (path, body, method = "POST") =>
    fetch(url + path, { headers, method, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(url + "/tickets")).status, 401);
    assert.equal(
      (await request("/auto-assign", { branchId: branch })).status,
      403,
    );
    let scope;
    t.mock.method(Lead, "findOne", (filter) => {
      scope = filter;
      return Promise.resolve(null);
    });
    assert.equal(
      (
        await request("/tickets", {
          leadId: lid,
          subject: "Test support",
          description: "Cannot use account",
          category: "login",
        })
      ).status,
      404,
    );
    assert.equal(String(scope.assignedTo), uid);
    assert.deepEqual(scope.branch.$in.map(String), [branch]);
    let followupPipeline;
    t.mock.method(LeadFollowUp, "aggregate", async (p) => {
      followupPipeline = p;
      return [{ rows: [], total: [] }];
    });
    assert.equal((await fetch(url + "/followups", { headers })).status, 200);
    assert.equal(String(followupPipeline[3].$match["leadDoc.assignedTo"]), uid);
    t.mock.method(SupportTicket, "findOne", () =>
      chain({ _id: lid, branch, version: 1 }),
    );
    assert.equal(
      (
        await request(
          "/tickets/" + lid,
          { version: 1, status: "resolved" },
          "PATCH",
        )
      ).status,
      403,
    );
    role = "manager";
    assert.equal(
      (await fetch(url + "/duplicates?branchId=" + other, { headers })).status,
      403,
    );
    let ticketScope;
    t.mock.method(SupportTicket, "findOneAndUpdate", async (filter) => {
      ticketScope = filter;
      return null;
    });
    assert.equal(
      (
        await request(
          "/tickets/" + lid,
          { version: 0, status: "resolved" },
          "PATCH",
        )
      ).status,
      409,
    );
    assert.equal(ticketScope.version, 0);
    assert.deepEqual(ticketScope.branch.$in.map(String), [branch]);
    role = "head";
    assert.equal(
      (await request("/auto-assign", { branchId: branch, limit: 101 })).status,
      400,
    );
    assert.equal(
      (await request("/auto-assign", { branchId: branch, employeeId: uid }))
        .status,
      400,
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("auto assignment claims only unassigned new leads and writes both histories in the transaction", async (t) => {
  t.mock.method(User, "findById", () =>
    chain({ _id: uid, ...user("head"), isActive: true }),
  );
  t.mock.method(Branch, "exists", async () => ({ _id: branch }));
  t.mock.method(EmployeeProfile, "find", () => chain([{ user: uid }]));
  t.mock.method(User, "find", () => chain([{ _id: uid }]));
  t.mock.method(Lead, "aggregate", async () => []);
  const session = {
    withTransaction: async (fn) => fn(),
    endSession: async () => {},
  };
  t.mock.method(Lead, "startSession", async () => session);
  let claims = 0;
  t.mock.method(Lead, "findOneAndUpdate", async (filter, update, options) => {
    assert.equal(filter.assignedTo, null);
    assert.equal(filter.status, "new");
    assert.equal(String(filter.branch), branch);
    assert.equal(options.session, session);
    assert.equal(update.$set.status, "assigned");
    return claims++ === 0 ? { _id: lid, branch, assignedTo: uid } : null;
  });
  let historyCount = 0;
  t.mock.method(LeadAssignmentHistory, "create", async (docs, options) => {
    assert.equal(options.session, session);
    historyCount++;
  });
  t.mock.method(LeadActivity, "create", async (docs, options) => {
    assert.equal(options.session, session);
    historyCount++;
  });
  const app = express();
  app.use(express.json());
  app.use("/operations", routes);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/operations/auto-assign`,
      {
        method: "POST",
        headers: {
          Authorization:
            "Bearer " + jwt.sign({ sub: uid }, process.env.JWT_SECRET),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ branchId: branch, limit: 3 }),
      },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.assigned, 1);
    assert.equal(historyCount, 2);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("reminders deduplicate across retries, escalate and suppress removed/reassigned leads", async (t) => {
  const followup = {
    _id: lid,
    lead: lid,
    branch,
    assignedTo: uid,
    scheduledAt: new Date("2026-11-05T08:00:00Z"),
  };
  t.mock.method(LeadFollowUp, "find", () => chain([followup]));
  let visible = true;
  t.mock.method(Lead, "findOne", (filter) => {
    assert.equal(filter.assignedTo, uid);
    assert.equal(filter.branch, branch);
    return chain(visible ? { name: "Lead" } : null);
  });
  t.mock.method(User, "find", () => chain([{ _id: uid }]));
  const keys = new Set();
  let writes = 0;
  t.mock.method(Notification, "updateOne", async (filter, update, options) => {
    assert(options.upsert);
    assert(update.$setOnInsert);
    keys.add(filter.dedupeKey);
    writes++;
  });
  t.mock.method(LeadFollowUp, "updateOne", async (filter) => {
    assert.equal(filter.status, "PENDING");
  });
  await runFollowUpReminders(new Date("2026-11-05T10:00:00Z"));
  await runFollowUpReminders(new Date("2026-11-05T10:00:00Z"));
  assert.equal(writes, 4);
  assert.equal(keys.size, 2);
  visible = false;
  await runFollowUpReminders(new Date("2026-11-05T10:00:00Z"));
  assert.equal(writes, 4);
});
