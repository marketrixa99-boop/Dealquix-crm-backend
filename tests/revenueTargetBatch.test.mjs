import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
process.env.MONGO_URI = "mongodb://127.0.0.1/isolated-target-batch";
process.env.JWT_SECRET = "isolated-target-batch-secret";
const { createRevenueTargetBatchInput } =
  await import("../dist/validators/revenueTarget.validator.js");
const { createBranchRevenueTasks } =
  await import("../dist/services/revenue-target-batch.service.js");
const { Branch } = await import("../dist/models/Branch.js");
const { User } = await import("../dist/models/User.js");
const { RevenueTargetBatch } =
  await import("../dist/models/RevenueTargetBatch.js");
const { BranchRevenueTarget } =
  await import("../dist/models/BranchRevenueTarget.js");
const { default: routes } =
  await import("../dist/routes/revenueTarget.routes.js");
const { errorHandler } = await import("../dist/middleware/error.middleware.js");
const actor = "507f1f77bcf86cd799439011",
  a = "507f1f77bcf86cd799439012",
  b = "507f1f77bcf86cd799439013";
const requestId = "0d252bdb-fabd-44b9-9c67-fc1606f2448c";
const input = {
  title: "Weekly branch revenue",
  description: "Monday through Saturday",
  targetAmount: 1000000,
  startDate: "2026-11-02",
  endDate: "2026-11-07",
  branchIds: [a, b],
  requestId,
};
const chain = (value) => {
  const q = {};
  for (const k of ["select", "session"]) q[k] = () => q;
  q.lean = async () => value;
  return q;
};
test("multi-branch validation rejects empty, duplicate, oversized, spoofed and reversed payloads", () => {
  assert(createRevenueTargetBatchInput.safeParse(input).success);
  for (const change of [
    { branchIds: [] },
    { branchIds: [a, a] },
    { branchIds: Array(51).fill(a) },
    { branchIds: ["bad"] },
    { requestId: "bad" },
    { startDate: "2026-11-08" },
    { achievedAmount: 1000000 },
    { createdBy: actor },
    { branchId: a },
  ])
    assert(
      !createRevenueTargetBatchInput.safeParse({ ...input, ...change }).success,
    );
});
test("batch creates one isolated target per branch atomically and replay does not create duplicates", async (t) => {
  const batches = new Map();
  let targets = [],
    active = true,
    failCreate = false,
    transactionCount = 0;
  const session = {
    endSession: async () => {},
    withTransaction: async (fn) => {
      transactionCount++;
      const oldBatches = new Map(batches),
        oldTargets = [...targets];
      try {
        return await fn();
      } catch (error) {
        batches.clear();
        for (const [k, v] of oldBatches) batches.set(k, v);
        targets = oldTargets;
        throw error;
      }
    },
  };
  t.mock.method(BranchRevenueTarget, "startSession", async () => session);
  t.mock.method(Branch, "find", (filter) => {
    assert.deepEqual(filter._id.$in, [a, b]);
    assert.equal(filter.isActive, true);
    return chain(active ? [{ _id: a }, { _id: b }] : [{ _id: a }]);
  });
  t.mock.method(RevenueTargetBatch, "findById", (key) =>
    chain(batches.get(key) || null),
  );
  t.mock.method(RevenueTargetBatch, "create", async (docs, options) => {
    assert.equal(options.session, session);
    for (const doc of docs) batches.set(doc._id, doc);
  });
  t.mock.method(BranchRevenueTarget, "create", async (docs, options) => {
    assert.equal(options.session, session);
    targets.push(...docs);
    if (failCreate) throw new Error("simulated persistence failure");
    return docs;
  });
  t.mock.method(BranchRevenueTarget, "find", (filter) =>
    chain(targets.filter((row) => row.batch === filter.batch)),
  );
  let result = await createBranchRevenueTasks(input, actor);
  assert.equal(result.count, 2);
  assert.equal(targets.length, 2);
  for (const [i, target] of targets.entries()) {
    assert.equal(target.branch, [a, b][i]);
    assert.equal(target.targetAmount, 1000000);
    assert.equal(target.startAt.toISOString(), "2026-11-01T18:30:00.000Z");
    assert.equal(target.endExclusive.toISOString(), "2026-11-07T18:30:00.000Z");
    assert(!("branchIds" in target));
    assert.equal(target.createdBy, actor);
  }
  result = await createBranchRevenueTasks(
    { ...input, branchIds: [b, a] },
    actor,
  );
  assert.equal(result.count, 2);
  assert.equal(targets.length, 2);
  assert.equal(transactionCount, 1);
  await assert.rejects(
    () => createBranchRevenueTasks({ ...input, title: "Changed title" }, actor),
    /different details/,
  );
  active = false;
  await assert.rejects(
    () =>
      createBranchRevenueTasks(
        { ...input, requestId: "1d252bdb-fabd-44b9-9c67-fc1606f2448c" },
        actor,
      ),
    /active/,
  );
  assert.equal(targets.length, 2);
  active = true;
  failCreate = true;
  await assert.rejects(
    () =>
      createBranchRevenueTasks(
        { ...input, requestId: "2d252bdb-fabd-44b9-9c67-fc1606f2448c" },
        actor,
      ),
    /simulated/,
  );
  assert.equal(targets.length, 2);
  assert.equal(batches.size, 1);
});
test("batch HTTP route denies employee writes before persistence", async (t) => {
  t.mock.method(User, "findById", () =>
    chain({
      _id: actor,
      name: "Employee",
      email: "test@example.com",
      role: "employee",
      branches: [a],
      isActive: true,
    }),
  );
  const app = express();
  app.use(express.json());
  app.use("/targets", routes);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/targets/batch`,
      {
        method: "POST",
        headers: {
          Authorization:
            "Bearer " + jwt.sign({ sub: actor }, process.env.JWT_SECRET),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      },
    );
    assert.equal(response.status, 403);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
