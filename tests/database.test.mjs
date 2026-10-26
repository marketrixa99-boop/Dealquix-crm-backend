import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import mongoose from 'mongoose';

process.env.MONGO_URI = 'mongodb://127.0.0.1/offline-test-not-connected';
process.env.JWT_SECRET = 'offline-test-not-production';
const { connectDatabase } = await import('../dist/config/database.js');
const { requireDatabase } = await import('../dist/middleware/database.middleware.js');

test('connection reuse, concurrency, failure recovery and bounded pool', async () => {
  const originalConnect = mongoose.connect;
  const originalState = mongoose.connection.readyState;
  let calls = 0;
  try {
    mongoose.connection.readyState = 0;
    let release;
    mongoose.connect = (_uri, options) => {
      calls++;
      assert.equal(options.maxPoolSize, 5);
      assert.equal(options.serverSelectionTimeoutMS, 5000);
      return new Promise(resolve => { release = resolve; });
    };
    const first = connectDatabase();
    const second = connectDatabase();
    assert.equal(calls, 1);
    mongoose.connection.readyState = 1;
    release(mongoose);
    await Promise.all([first, second]);
    await connectDatabase();
    assert.equal(calls, 1, 'warm connected requests reuse the pool');

    mongoose.connection.readyState = 0;
    mongoose.connect = async () => { calls++; throw new Error('test failure'); };
    await assert.rejects(connectDatabase(), /test failure/);
    mongoose.connect = async () => { calls++; mongoose.connection.readyState = 1; return mongoose; };
    await connectDatabase();
    assert.equal(calls, 3, 'a failed attempt can be retried');
  } finally {
    mongoose.connect = originalConnect;
    mongoose.connection.readyState = originalState;
  }
});

test('database gate waits before executing an API handler', async t => {
  let release;
  let entered;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let handled = false;
  const app = express();
  app.use(requireDatabase(() => { entered(); return pending; }));
  app.get('/test', (_req, res) => { handled = true; res.json({ success: true }); });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const request = fetch(`http://127.0.0.1:${server.address().port}/test`);
  await started;
  assert.equal(handled, false);
  release();
  assert.equal((await request).status, 200);
  assert.equal(handled, true);
});

test('unavailable database returns 503 without leaking credentials or running handler', async t => {
  const app = express();
  const sensitive = 'mongodb://user:private-password@private-host/db';
  app.use(requireDatabase(async () => { throw new Error(sensitive); }));
  app.get('/test', () => assert.fail('handler must not run'));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/test`);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('retry-after'), '5');
  const body = await response.text();
  assert.ok(!body.includes('private-password'));
  assert.equal(JSON.parse(body).code, 'DATABASE_UNAVAILABLE');
});

test('real Express export gates API routes but keeps liveness and CORS preflight independent', async t => {
  process.env.VERCEL = '1';
  const { default: app } = await import('../dist/app.js');
  const originalConnect = mongoose.connect;
  const originalState = mongoose.connection.readyState;
  let connections = 0;
  mongoose.connection.readyState = 0;
  mongoose.connect = async () => { connections++; throw new Error('offline only'); };
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    mongoose.connect = originalConnect;
    mongoose.connection.readyState = originalState;
    delete process.env.VERCEL;
  });
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal(connections, 0, 'liveness does not open a database');
  const preflight = await fetch(`${base}/api/v1/chat/groups`, {
    method: 'OPTIONS', headers: { Origin: 'https://dealqix.com', 'Access-Control-Request-Method': 'GET' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://dealqix.com');
  assert.equal(connections, 0);
  assert.equal((await fetch(`${base}/api/v1/health`)).status, 503);
  assert.equal(connections, 1);
  assert.equal((await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })).status, 503);
  assert.equal((await fetch(`${base}/api/v1/integrations/webhooks/not-a-real-provider`)).status, 503);
  assert.equal(connections, 3, 'API and webhook failures retry without running handlers');
});
