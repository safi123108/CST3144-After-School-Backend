const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const serverModule = require('../server');
const { createMockMongo } = require('./helpers/mock-db');
const { sendAppRequest } = require('./helpers/http-client');

test('startServer binds requested port, forwards dbName/corsOrigin, and cleans up on start failure', async () => {
  const prevUri = process.env.MONGODB_URI;
  delete process.env.MONGODB_URI;
  try {
    await assert.rejects(
      () => serverModule.startServer({ mongoUri: undefined }),
      /MONGODB_URI is not defined/
    );
  } finally {
    if (prevUri !== undefined) {
      process.env.MONGODB_URI = prevUri;
    }
  }

  // Failure during connect closes client cleanly and resets state
  const failingMock = createMockMongo(
    {},
    {
      onConnect: async () => {
        throw new Error('Simulated Atlas unreachable');
      }
    }
  );
  await assert.rejects(
    () =>
      serverModule.startServer({
        port: 0,
        mongoUri: 'mongodb://mock-cluster/fail_test',
        createClient: () => failingMock.client
      }),
    /Simulated Atlas unreachable/
  );
  assert.equal(failingMock.stats.closeCalls, 1);

  // Successful startup honors custom dbName and corsOrigin
  const liveMock = createMockMongo({
    lessons: [{ topic: 'Art', location: 'Studio A', price: 15, space: 5, image: 'art.png' }]
  });

  const started = await serverModule.startServer({
    port: 0,
    mongoUri: 'mongodb://mock-cluster/render_test',
    dbName: 'render_custom_db',
    corsOrigin: 'https://student-site.github.io',
    createClient: () => liveMock.client
  });

  try {
    assert.equal(liveMock.stats.connectCalls, 1);
    assert.equal(liveMock.stats.lastDbName, 'render_custom_db');

    const port = started.server.address().port;
    assert.equal(port > 0, true);

    const healthRes = await sendAppRequest(started.app, 'GET', '/api/health', {
      headers: { Origin: 'https://student-site.github.io' }
    });
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.json.database.name, 'render_custom_db');
    assert.equal(healthRes.headers['access-control-allow-origin'], 'https://student-site.github.io');

    // stopServer idempotency when invoked concurrently and repeatedly
    await Promise.all([serverModule.stopServer(), serverModule.stopServer()]);
    await serverModule.stopServer();
    assert.equal(liveMock.stats.closeCalls, 1);
  } finally {
    await serverModule.stopServer();
  }
});

test('registerShutdownHandlers deduplicates listeners and performs graceful SIGTERM shutdown', async () => {
  const { client, stats } = createMockMongo();
  const fakeProcess = new EventEmitter();
  const exitCodes = [];

  const first = serverModule.registerShutdownHandlers({
    targetProcess: fakeProcess,
    onExit: (code) => exitCodes.push(code)
  });
  const second = serverModule.registerShutdownHandlers({
    targetProcess: fakeProcess,
    onExit: (code) => exitCodes.push(code)
  });

  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(fakeProcess.listenerCount('SIGTERM'), 1);
  assert.equal(fakeProcess.listenerCount('SIGINT'), 1);

  const started = await serverModule.startServer({
    port: 0,
    mongoUri: 'mongodb://mock-cluster/shutdown_test',
    corsOrigin: '*',
    createClient: () => client
  });

  try {
    assert.equal(started.server.listening, true);
    fakeProcess.emit('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(started.server.listening, false);
    assert.equal(stats.closeCalls, 1);
    assert.deepEqual(exitCodes, [0]);
  } finally {
    await serverModule.stopServer();
  }
});

test('registerShutdownHandlers exits with code 1 when closing client throws during signal shutdown', async () => {
  // Verify signal handler error path by starting server with failing close
  const failingCloseMock = createMockMongo(
    {},
    {
      onClose: async () => {
        throw new Error('Close socket failure');
      }
    }
  );

  // Use a fresh module instance so registerShutdownHandlers attaches once to an isolated fakeProcess
  const serverModulePath = require.resolve('../server');
  delete require.cache[serverModulePath];
  const isolatedServer = require('../server');

  const fakeProcess = new EventEmitter();
  const exitCodes = [];
  const origConsoleError = console.error;
  console.error = () => {};

  try {
    assert.equal(
      isolatedServer.registerShutdownHandlers({
        targetProcess: fakeProcess,
        onExit: (code) => exitCodes.push(code)
      }),
      true
    );

    await isolatedServer.startServer({
      port: 0,
      mongoUri: 'mongodb://mock-cluster/fail_close_test',
      corsOrigin: '*',
      createClient: () => failingCloseMock.client
    });

    fakeProcess.emit('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(exitCodes, [1]);
  } finally {
    console.error = origConsoleError;
    await isolatedServer.stopServer().catch(() => {});
    delete require.cache[serverModulePath];
  }
});
