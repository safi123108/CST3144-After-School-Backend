const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp } = require('../app');
const { resolveRequestedFilename } = require('../middleware/images');
const { createMockMongo } = require('./helpers/mock-db');
const { sendAppRequest } = require('./helpers/http-client');

const PUBLIC_IMAGES_DIR = path.join(__dirname, '..', 'public', 'images');

test('resolveRequestedFilename normalizes filenames and blocks traversal, separators, and bad encoding', () => {
  assert.deepEqual(resolveRequestedFilename('/maths.png?v=123'), {
    safeRelativeName: 'maths.png',
    displayName: 'maths.png'
  });
  assert.deepEqual(resolveRequestedFilename('/missing.png?w=400&cb=1'), {
    safeRelativeName: 'missing.png',
    displayName: 'missing.png'
  });
  assert.deepEqual(resolveRequestedFilename('/nested/maths.png?x=1'), {
    safeRelativeName: null,
    displayName: 'maths.png'
  });
  assert.deepEqual(resolveRequestedFilename('/..%2Fpackage.json?x=1'), {
    safeRelativeName: null,
    displayName: 'package.json'
  });
  assert.deepEqual(resolveRequestedFilename('/%ZZ.png'), {
    safeRelativeName: null,
    displayName: '%ZZ.png'
  });
  assert.deepEqual(resolveRequestedFilename('/'), {
    safeRelativeName: null,
    displayName: ''
  });
});

test('all seeded .png filenames resolve cleanly to matching .svg assets for GET and HEAD', async () => {
  const { db, client } = createMockMongo();
  const app = createApp({ db, client, corsOrigin: '*' });

  const seededSubjects = [
    'maths', 'english', 'science', 'history', 'geography',
    'art', 'music', 'pe', 'drama', 'french'
  ];

  for (const subject of seededSubjects) {
    const expectedSvg = fs.readFileSync(path.join(PUBLIC_IMAGES_DIR, `${subject}.svg`), 'utf8');
    const res = await sendAppRequest(app, 'GET', `/images/${subject}.png`);
    assert.equal(res.status, 200, `Expected 200 for /images/${subject}.png`);
    assert.match(res.headers['content-type'], /^image\/svg\+xml/);
    assert.equal(res.text, expectedSvg);
  }

  // Case-insensitive .PNG with query string
  const queryRes = await sendAppRequest(app, 'GET', '/images/maths.PNG?v=42');
  assert.equal(queryRes.status, 200);
  assert.match(queryRes.headers['content-type'], /^image\/svg\+xml/);

  // HEAD request
  const headRes = await sendAppRequest(app, 'HEAD', '/images/maths.png');
  assert.equal(headRes.status, 200);
  assert.match(headRes.headers['content-type'], /^image\/svg\+xml/);
  assert.equal(headRes.text, '');
});

test('direct .svg static assets are served without altering filenames', async () => {
  const { db, client } = createMockMongo();
  const app = createApp({ db, client, corsOrigin: '*' });

  for (const svgFile of ['maths.svg', 'hero.svg']) {
    const expectedSvg = fs.readFileSync(path.join(PUBLIC_IMAGES_DIR, svgFile), 'utf8');
    const res = await sendAppRequest(app, 'GET', `/images/${svgFile}`);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^image\/svg\+xml/);
    assert.equal(res.text, expectedSvg);
  }
});

test('missing images, non-png fallbacks, directory masquerading, traversal, and POST return 404 JSON', async () => {
  const { db, client } = createMockMongo();
  const app = createApp({ db, client, corsOrigin: '*' });

  const expected404Cases = [
    ['/images/missing.png', 'missing.png'],
    ['/images/missing.png?cacheBust=999&w=400', 'missing.png'],
    ['/images/maths.jpg?v=1', 'maths.jpg'],
    ['/images/nested/maths.png?v=1', 'maths.png'],
    ['/images/..%2Fpackage.json?x=1', 'package.json'],
    ['/images/%ZZ.png?v=1', '%ZZ.png'],
    ['/images/', '(none)']
  ];

  for (const [reqPath, expectedName] of expected404Cases) {
    const res = await sendAppRequest(app, 'GET', reqPath);
    assert.equal(res.status, 404, `Expected 404 for ${reqPath}`);
    assert.deepEqual(res.json, {
      error: 'Image not found',
      message: `The requested image file '${expectedName}' does not exist on this server.`
    });
  }

  // Non-GET/HEAD requests on /images also fall through to clean 404 JSON
  const postRes = await sendAppRequest(app, 'POST', '/images/maths.png');
  assert.equal(postRes.status, 404);
  assert.equal(postRes.json.error, 'Image not found');

  // Verify stats.isFile() rejects a subdirectory whose name matches <name>.svg
  const tmpImagesDir = fs.mkdtempSync(path.join(__dirname, 'tmp-img-dir-'));
  try {
    fs.mkdirSync(path.join(tmpImagesDir, 'fake.svg'));
    const customApp = createApp({ db, client, imagesDir: tmpImagesDir, corsOrigin: '*' });
    const dirRes = await sendAppRequest(customApp, 'GET', '/images/fake.png');
    assert.equal(dirRes.status, 404);
    assert.equal(dirRes.json.error, 'Image not found');
  } finally {
    fs.rmSync(tmpImagesDir, { recursive: true, force: true });
  }
});
