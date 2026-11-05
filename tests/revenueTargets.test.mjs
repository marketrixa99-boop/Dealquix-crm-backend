import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
process.env.MONGO_URI = "mongodb://127.0.0.1/isolated-revenue-target-test";
process.env.JWT_SECRET = "isolated-revenue-target-test-secret";
const {
  indiaTargetRange,
  revenueTargetProgress,
  createRevenueTargetInput,
  editRevenueTargetInput,
} = await import("../dist/validators/revenueTarget.validator.js");
const { BranchRevenueTarget } =
  await import("../dist/models/BranchRevenueTarget.js");
const { User } = await import("../dist/models/User.js");
const { Branch } = await import("../dist/models/Branch.js");
const { default: routes } =
  await import("../dist/routes/revenueTarget.routes.js");
const { errorHandler } = await import("../dist/middleware/error.middleware.js");
const uid = "507f1f77bcf86cd799439011",
  branch = "507f1f77bcf86cd799439012",
  other = "507f1f77bcf86cd799439013",
  tid = "507f1f77bcf86cd799439014";
const chain = (value) => {
  const q = {};
  for (const x of ["select", "sort"]) q[x] = () => q;
  q.lean = async () => value;
  return q;
};
const brief = {
  title: "Ten day branch target",
  branchId: branch,
  targetAmount: 2500000,
  startDate: "2026-11-01",
  endDate: "2026-11-10",
};
test("inclusive India calendar dates cover final milliseconds and reject invalid calendar/range inputs", () => {
  const range = indiaTargetRange(brief.startDate, brief.endDate);
  assert.equal(range.startAt.toISOString(), "2026-10-31T18:30:00.000Z");
  assert.equal(range.endExclusive.toISOString(), "2026-11-10T18:30:00.000Z");
  for (const [value, expected] of [
    ["2026-10-31T18:29:59.999Z", false],
    ["2026-10-31T18:30:00.000Z", true],
    ["2026-11-10T18:29:59.999Z", true],
    ["2026-11-10T18:30:00.000Z", false],
  ]) {
    const date = new Date(value);
    assert.equal(date >= range.startAt && date < range.endExclusive, expected);
  }
  assert.equal(
    indiaTargetRange("2024-02-29", "2024-02-29").endExclusive -
      indiaTargetRange("2024-02-29", "2024-02-29").startAt,
    86400000,
  );
  for (const change of [
    { startDate: "2026-02-30" },
    { endDate: "2026-10-31" },
    { endDate: "2028-11-10" },
    { targetAmount: 0 },
    { targetAmount: 1.111 },
    { achievedAmount: 2500000 },
    { status: "completed" },
    { startAt: "2020-01-01" },
  ])
    assert(
      !createRevenueTargetInput.safeParse({ ...brief, ...change }).success,
    );
  assert(
    !editRevenueTargetInput.safeParse({
      title: brief.title,
      targetAmount: 1,
      startDate: brief.startDate,
      endDate: brief.endDate,
      archived: false,
    }).success,
  );
});
test("progress handles partial, zero, overachievement and paise without counting entries twice", () => {
  assert.deepEqual(revenueTargetProgress(2500000, 1000000), {
    achievedAmount: 1000000,
    remainingAmount: 1500000,
    percent: 40,
    barPercent: 40,
    completed: false,
  });
  assert.equal(revenueTargetProgress(2500000, 0).percent, 0);
  const over = revenueTargetProgress(2500000, 3000000);
  assert.equal(over.percent, 120);
  assert.equal(over.barPercent, 100);
  assert.equal(over.remainingAmount, 0);
  assert.equal(revenueTargetProgress(1, 0.1 + 0.2).achievedAmount, 0.3);
  assert.equal(revenueTargetProgress(1, 0.1 + 0.2).remainingAmount, 0.7);
});

// Evaluate the actual generated lookup predicate against dated revenue fixtures.
// This verifies the route's selected fields/operators without connecting to live data.
const expression = (expr, doc, variables) => {
  if (typeof expr === "string") {
    if (expr.startsWith("$$")) return variables[expr.slice(2)];
    if (expr.startsWith("$")) return doc[expr.slice(1)];
    return expr;
  }
  if (!expr || typeof expr !== "object") return expr;
  if (expr.$and) return expr.$and.every((x) => expression(x, doc, variables));
  for (const op of ["$eq", "$gte", "$lt"])
    if (expr[op]) {
      const [a, b] = expr[op].map((x) => expression(x, doc, variables));
      return op === "$eq"
        ? String(a) === String(b)
        : op === "$gte"
          ? a >= b
          : a < b;
    }
  throw new Error("Unexpected predicate");
};
test("HTTP target totals use verified entry dates including late approvals and recalculation, with branch access isolation", async (t) => {
  let role = "employee",
    memberships = [branch],
    aggregateCalls = 0;
  t.mock.method(User, "findById", () =>
    chain({
      _id: uid,
      name: "Test",
      email: "test@example.com",
      role,
      branches: memberships,
      isActive: true,
    }),
  );
  const range = indiaTargetRange(brief.startDate, brief.endDate);
  const target = {
    _id: tid,
    ...brief,
    branch,
    branchName: "Deesa",
    ...range,
    version: 0,
    archived: false,
  };
  const rows = [
    {
      branch,
      status: "VERIFIED",
      amount: 1000000,
      date: new Date("2026-10-31T18:30:00Z"),
      verifiedAt: new Date("2026-11-11T06:00:00Z"),
    },
    {
      branch,
      status: "PENDING",
      amount: 500000,
      date: new Date("2026-11-05T06:00:00Z"),
    },
    {
      branch,
      status: "REJECTED",
      amount: 900000,
      date: new Date("2026-11-05T06:00:00Z"),
    },
    {
      branch: other,
      status: "VERIFIED",
      amount: 800000,
      date: new Date("2026-11-05T06:00:00Z"),
    },
    {
      branch,
      status: "VERIFIED",
      amount: 100000,
      date: new Date("2026-11-10T18:29:59.999Z"),
    },
    {
      branch,
      status: "VERIFIED",
      amount: 700000,
      date: new Date("2026-11-10T18:30:00Z"),
    },
  ];
  t.mock.method(BranchRevenueTarget, "aggregate", async (pipeline) => {
    aggregateCalls++;
    const scope = pipeline[0].$match;
    if (scope.branch?.$in?.length === 0) return [{ rows: [], total: [] }];
    if (role !== "head")
      assert.deepEqual(scope.branch.$in.map(String), [branch]);
    const lookup = pipeline[2].$facet.rows.find(
      (x) => x.$lookup?.from === "revenues",
    ).$lookup;
    const match = lookup.pipeline[0].$match;
    assert.equal(match.status, "VERIFIED");
    assert.equal(lookup.let.start, "$startAt");
    assert.equal(lookup.let.end, "$endExclusive");
    assert(!JSON.stringify(lookup.pipeline).includes("verifiedAt"));
    assert(!JSON.stringify(lookup.pipeline).includes("createdAt"));
    const counted = rows.filter(
      (r) =>
        r.status === match.status &&
        expression(match.$expr, r, {
          branchId: branch,
          start: range.startAt,
          end: range.endExclusive,
        }),
    );
    return [
      {
        rows: [
          {
            ...target,
            verifiedAmount: counted.reduce((sum, r) => sum + r.amount, 0),
            verifiedEntries: counted.length,
          },
        ],
        total: [{ count: 1 }],
      },
    ];
  });
  const app = express();
  app.use(express.json());
  app.use("/targets", routes);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}/targets`,
    headers = {
      Authorization: "Bearer " + jwt.sign({ sub: uid }, process.env.JWT_SECRET),
      "Content-Type": "application/json",
    };
  const list = async () => {
    const r = await fetch(url, { headers });
    assert.equal(r.status, 200);
    return (await r.json()).data;
  };
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal(
      (
        await fetch(url, {
          headers,
          method: "POST",
          body: JSON.stringify(brief),
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(`${url}?branchId=${other}`, { headers })).status,
      403,
    );
    assert.equal(aggregateCalls, 0);
    let result = await list();
    assert.equal(result.rows[0].achievedAmount, 1100000);
    assert.equal(result.rows[0].verifiedEntries, 2);
    assert.equal(result.rows[0].percent, 44);
    rows[1].status = "VERIFIED";
    result = await list();
    assert.equal(result.rows[0].achievedAmount, 1600000);
    assert.equal(result.rows[0].percent, 64);
    result = await list();
    assert.equal(result.rows[0].achievedAmount, 1600000);
    rows[0].status = "REJECTED";
    result = await list();
    assert.equal(result.rows[0].achievedAmount, 600000);
    memberships = [];
    assert.equal((await list()).rows.length, 0);
    role = "head";
    result = await list();
    assert.equal(result.rows[0].achievedAmount, 600000);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
test("Head create derives UTC boundaries server-side and edits require optimistic version", async (t) => {
  t.mock.method(User, "findById", () =>
    chain({
      _id: uid,
      name: "Head",
      email: "h@example.com",
      role: "head",
      branches: [],
      isActive: true,
    }),
  );
  t.mock.method(Branch, "exists", async () => ({ _id: branch }));
  t.mock.method(BranchRevenueTarget, "create", async (payload) => {
    assert.equal(payload.startAt.toISOString(), "2026-10-31T18:30:00.000Z");
    assert.equal(
      payload.endExclusive.toISOString(),
      "2026-11-10T18:30:00.000Z",
    );
    assert.equal(payload.createdBy, uid);
    return { _id: tid, ...payload };
  });
  t.mock.method(
    BranchRevenueTarget,
    "findOneAndUpdate",
    async (filter, update) => {
      assert.equal(filter.version, 0);
      assert.equal(update.$inc.version, 1);
      return null;
    },
  );
  const app = express();
  app.use(express.json());
  app.use("/targets", routes);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}/targets`,
    headers = {
      Authorization: "Bearer " + jwt.sign({ sub: uid }, process.env.JWT_SECRET),
      "Content-Type": "application/json",
    };
  try {
    assert.equal(
      (
        await fetch(url, {
          headers,
          method: "POST",
          body: JSON.stringify(brief),
        })
      ).status,
      201,
    );
    const { branchId, ...fields } = brief;
    assert.equal(
      (
        await fetch(url + "/" + tid, {
          headers,
          method: "PATCH",
          body: JSON.stringify({ ...fields, archived: false, version: 0 }),
        })
      ).status,
      409,
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});
