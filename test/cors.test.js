const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp } = require('../app');
const {
  normalizeOrigin,
  parseAllowedOrigins,
  createCorsOptions
} = require('../config/cors');
const { createMockMongo } = require('./helpers/mock-db');
const { sendAppRequest } = require('./helpers/http-client');

test('CORS config helpers normalize origins, handle blank/wildcard configs, and build expected options', () => {
  assert.equal(normalizeOrigin(' https://User.GitHub.io/app/ '), 'https://user.github.io');
  assert.equal(normalizeOrigin('http://localhost:5500///'), 'http://localhost:5500');
  assert.equal(normalizeOrigin('   '), '');
  assert.equal(normalizeOrigin(null), '');

  assert.equal(parseAllowedOrigins(undefined), null);
  assert.equal(parseAllowedOrigins('   '), null);
  assert.equal(parseAllowedOrigins('*'), null);
  assert.equal(parseAllowedOrigins('http://localhost:5500, *'), null);

  assert.deepEqual(
    parseAllowedOrigins('http://localhost:5500/, https://Alice.github.io/repo, http://localhost:5500'),
    ['http://localhost:5500', 'https://alice.github.io']
  );

  const openOpts = createCorsOptions('');
  assert.equal(openOpts.origin, '*');
  assert.equal(openOpts.optionsSuccessStatus, 204);
  assert.deepEqual(openOpts.methods, ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
});

test('CORS middleware enforces default open mode, allowlist mode, blocked origins, non-browser requests, and OPTIONS preflight', async () => {
  const { db, client } = createMockMongo({
    lessons: [{ topic: 'Maths', location: 'Room 101', price: 10, space: 5, image: 'maths.png' }]
  });

  // 1. Default mode when CORS_ORIGIN is omitted (isolated from process.env)
  const prevCorsOrigin = process.env.CORS_ORIGIN;
  delete process.env.CORS_ORIGIN;
  try {
    const defaultApp = createApp({ db, client });
    const res = await sendAppRequest(defaultApp, 'GET', '/lessons', {
      headers: { Origin: 'http://localhost:5500' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.equal(res.headers['access-control-allow-credentials'], undefined);
  } finally {
    if (prevCorsOrigin !== undefined) {
      process.env.CORS_ORIGIN = prevCorsOrigin;
    }
  }

  // 2. Strict allowlist mode covering local dev + GitHub Pages origins
  const configuredApp = createApp({
    db,
    client,
    corsOrigin: 'http://127.0.0.1:5500/, http://localhost:5500, https://StudentUser.github.io/after-school/'
  });

  const allowedLocal = await sendAppRequest(configuredApp, 'GET', '/lessons', {
    headers: { Origin: 'http://127.0.0.1:5500' }
  });
  assert.equal(allowedLocal.status, 200);
  assert.equal(allowedLocal.headers['access-control-allow-origin'], 'http://127.0.0.1:5500');

  const allowedPages = await sendAppRequest(configuredApp, 'GET', '/lessons', {
    headers: { Origin: 'https://studentuser.github.io' }
  });
  assert.equal(allowedPages.status, 200);
  assert.equal(allowedPages.headers['access-control-allow-origin'], 'https://studentuser.github.io');

  const disallowed = await sendAppRequest(configuredApp, 'GET', '/lessons', {
    headers: { Origin: 'https://untrusted.example.com' }
  });
  assert.equal(disallowed.status, 200);
  assert.equal(disallowed.headers['access-control-allow-origin'], undefined);

  // Non-browser API calls (no Origin header) work without error
  const curlLike = await sendAppRequest(configuredApp, 'GET', '/lessons');
  assert.equal(curlLike.status, 200);
  assert.equal(Array.isArray(curlLike.json), true);

  // OPTIONS preflight for allowed vs disallowed origins
  const preflightAllowed = await sendAppRequest(configuredApp, 'OPTIONS', '/orders', {
    headers: {
      Origin: 'https://studentuser.github.io',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Content-Type'
    }
  });
  assert.equal(preflightAllowed.status, 204);
  assert.equal(preflightAllowed.headers['access-control-allow-origin'], 'https://studentuser.github.io');
  assert.match(preflightAllowed.headers['access-control-allow-methods'], /POST/);
  assert.match(preflightAllowed.headers['access-control-allow-methods'], /DELETE/);

  const preflightBlocked = await sendAppRequest(configuredApp, 'OPTIONS', '/orders', {
    headers: {
      Origin: 'https://untrusted.example.com',
      'Access-Control-Request-Method': 'DELETE'
    }
  });
  assert.equal(preflightBlocked.headers['access-control-allow-origin'], undefined);
});

test('.env.example provides safe template keys without real credentials and .gitignore excludes .env', () => {
  const envExample = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  const gitignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');

  assert.match(envExample, /^PORT=/m);
  assert.match(envExample, /^MONGODB_URI=mongodb\+srv:\/\/<username>:<password>@<cluster-host>\/<database>/m);
  assert.match(envExample, /^DB_NAME=after_school_app/m);
  assert.match(envExample, /^CORS_ORIGIN=/m);
  assert.match(gitignore, /^\.env$/m);
});
