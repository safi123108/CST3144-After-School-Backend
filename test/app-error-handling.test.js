const test = require('node:test');
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');

const { createApp, DEFAULT_DB_NAME } = require('../app');
const { createMockMongo } = require('./helpers/mock-db');
const { sendAppRequest } = require('./helpers/http-client');

test('createApp initializes with DI options without binding ports or opening DB connections', () => {
  const { db, client, stats } = createMockMongo();
  const app = createApp({
    getDb: () => db,
    getClient: () => client,
    dbName: 'custom_di_db',
    corsOrigin: '*'
  });

  assert.equal(typeof app, 'function');
  assert.equal(typeof DEFAULT_DB_NAME, 'string');
  assert.equal(stats.connectCalls, 0);
  assert.equal(stats.sessionsStarted, 0);
});

test('GET / and GET /api/health report app and dynamic database readiness', async () => {
  const { db, client } = createMockMongo();
  let activeDb = db;

  const app = createApp({
    getDb: () => activeDb,
    getClient: () => client,
    dbName: 'health_check_db',
    corsOrigin: '*'
  });

  const rootRes = await sendAppRequest(app, 'GET', '/');
  assert.equal(rootRes.status, 200);
  assert.equal(rootRes.text, 'After-School App Backend is running!');

  const connectedRes = await sendAppRequest(app, 'GET', '/api/health');
  assert.equal(connectedRes.status, 200);
  assert.deepEqual(connectedRes.json, {
    success: true,
    message: 'Backend is working correctly',
    database: {
      connected: true,
      name: 'health_check_db'
    }
  });

  activeDb = null;
  const disconnectedRes = await sendAppRequest(app, 'GET', '/api/health');
  assert.equal(disconnectedRes.status, 200);
  assert.deepEqual(disconnectedRes.json, {
    success: true,
    message: 'Backend is working correctly',
    database: {
      connected: false,
      name: null
    }
  });
});

test('malformed JSON returns HTTP 400 JSON and never exposes stack traces', async () => {
  const { db, client } = createMockMongo();
  const app = createApp({ db, client, corsOrigin: '*' });

  const malformedRes = await sendAppRequest(app, 'POST', '/orders', {
    headers: { 'Content-Type': 'application/json' },
    rawBody: '{"name": "Alex", "items": ['
  });
  assert.equal(malformedRes.status, 400);
  assert.deepEqual(malformedRes.json, {
    success: false,
    error: 'Invalid JSON',
    message: 'Request body contains malformed JSON.'
  });
  assert.equal('stack' in malformedRes.json, false);

  const noContentTypeRes = await sendAppRequest(app, 'POST', '/orders', {
    rawBody: '{"name":"Alex"}'
  });
  assert.equal(noContentTypeRes.status, 400);
  assert.equal(noContentTypeRes.json.success, false);
  assert.equal(noContentTypeRes.json.error, 'Invalid name');
  assert.equal(noContentTypeRes.text.includes('SyntaxError'), false);
});

test('unknown routes return HTTP 404 JSON without leaking stack internals', async () => {
  const { db, client } = createMockMongo();
  const app = createApp({ db, client, corsOrigin: '*' });

  const getRes = await sendAppRequest(app, 'GET', '/api/does-not-exist?check=1');
  assert.equal(getRes.status, 404);
  assert.deepEqual(getRes.json, {
    success: false,
    error: 'Not found',
    message: "Route 'GET /api/does-not-exist?check=1' was not found."
  });

  const postRes = await sendAppRequest(app, 'POST', '/unknown', { jsonBody: { test: true } });
  assert.equal(postRes.status, 404);
  assert.equal(postRes.json.success, false);
  assert.equal(postRes.json.error, 'Not found');
});

test('internal database errors return HTTP 500 JSON without leaking connection strings or stacks', async () => {
  const syntheticSecret = 'mongodb+srv://mockuser:MockPass999@internal-cluster.invalid/secret_db';
  const { db, client } = createMockMongo(
    {},
    {
      onFind: async () => {
        throw new Error(`Driver failure contacting ${syntheticSecret}`);
      }
    }
  );
  const app = createApp({ db, client, corsOrigin: '*' });

  const origConsoleError = console.error;
  console.error = () => {};
  try {
    const res = await sendAppRequest(app, 'GET', '/lessons');
    assert.equal(res.status, 500);
    assert.deepEqual(res.json, {
      success: false,
      message: 'Failed to retrieve lessons from database'
    });
    assert.equal(res.text.includes('mongodb+srv://'), false);
    assert.equal(res.text.includes('MockPass999'), false);
    assert.equal('stack' in res.json, false);
  } finally {
    console.error = origConsoleError;
  }
});

test('database-backed routes return HTTP 503 JSON when database or session client is unavailable', async () => {
  const appNoDb = createApp({ db: null, client: null, corsOrigin: '*' });
  const sampleId = new ObjectId().toHexString();

  const dbRequiredChecks = [
    ['GET', '/lessons', undefined],
    ['GET', '/lessons/search?q=Maths', undefined],
    ['PUT', `/lessons/${sampleId}`, { topic: 'Physics' }],
    ['POST', '/orders', { name: 'Alex', phone: '12345', items: [{ lessonId: sampleId, space: 1 }] }],
    ['GET', '/teachers', undefined],
    ['GET', `/teachers/${sampleId}/lessons`, undefined],
    ['GET', `/enrolment/${sampleId}`, undefined],
    ['DELETE', `/orders/${sampleId}`, undefined]
  ];

  for (const [method, urlPath, body] of dbRequiredChecks) {
    const res = await sendAppRequest(appNoDb, method, urlPath, { jsonBody: body });
    assert.equal(res.status, 503, `Expected 503 for ${method} ${urlPath}`);
    assert.deepEqual(res.json, {
      success: false,
      error: 'Service unavailable',
      message: 'Database connection is not ready.'
    });
  }

  // DB present, but session client missing for transactional routes
  const { db } = createMockMongo();
  const appNoClient = createApp({ db, client: null, corsOrigin: '*' });

  const confirmNoClient = await sendAppRequest(appNoClient, 'PUT', `/lessons/${sampleId}`, {
    jsonBody: { space: 4, orderId: sampleId }
  });
  assert.equal(confirmNoClient.status, 503);
  assert.deepEqual(confirmNoClient.json, {
    success: false,
    error: 'Service unavailable',
    message: 'Database client session is unavailable.'
  });

  const teacherSyncNoClient = await sendAppRequest(appNoClient, 'PUT', `/lessons/${sampleId}`, {
    jsonBody: { teacherId: sampleId }
  });
  assert.equal(teacherSyncNoClient.status, 503);
  assert.equal(teacherSyncNoClient.json.error, 'Service unavailable');

  const deleteNoClient = await sendAppRequest(appNoClient, 'DELETE', `/orders/${sampleId}`);
  assert.equal(deleteNoClient.status, 503);
  assert.equal(deleteNoClient.json.error, 'Service unavailable');
});
