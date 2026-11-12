const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ObjectId } = require('mongodb');

const seedModule = require('../seed');
const { createMockMongo } = require('./helpers/mock-db');

test('seed definitions maintain consistent 3-teacher / 10-lesson relationships and matching SVG assets', () => {
  assert.equal(seedModule.teachers.length, 3);
  assert.equal(seedModule.lessons.length, 10);

  const teacherMap = new Map(
    seedModule.teachers.map((t) => [t._id.toHexString(), t])
  );
  const publicImagesDir = path.join(__dirname, '..', 'public', 'images');

  for (const lesson of seedModule.lessons) {
    assert.equal(lesson.space, 5);
    const assignedTeacher = teacherMap.get(lesson.teacherId.toHexString());
    assert.ok(assignedTeacher, `Missing teacher for lesson ${lesson.topic}`);
    assert.equal(
      assignedTeacher.lessonIds.some((id) => id.equals(lesson._id)),
      true,
      `Teacher ${assignedTeacher.name} missing lessonId for ${lesson.topic}`
    );

    const svgName = lesson.image.replace(/\.png$/i, '.svg');
    assert.equal(fs.existsSync(path.join(publicImagesDir, svgName)), true, `Missing asset ${svgName}`);
  }
});

test('parseSeedOptions distinguishes safe default mode from explicit --reset flag', () => {
  assert.deepEqual(seedModule.parseSeedOptions([]), { reset: false });
  assert.deepEqual(seedModule.parseSeedOptions(['--verbose']), { reset: false });
  assert.deepEqual(seedModule.parseSeedOptions(['--reset']), { reset: true });
  assert.deepEqual(seedModule.parseSeedOptions(null), { reset: false });
});

test('seedDatabase inserts cleanly, preserves live spaces/orders on re-runs, handles NamespaceNotFound, and avoids duplicate indexes', async () => {
  const existingOrder = {
    _id: new ObjectId(),
    name: 'Existing Customer',
    phone: '07123456789',
    status: 'confirmed',
    items: [{ lessonId: seedModule.lessonIds.maths, space: 2, confirmed: true }]
  };

  // Start with missing 'order'/'teacher' namespace before indexes exist (MongoDB code 26)
  const { db, store } = createMockMongo({
    missingNamespaces: ['order', 'teacher']
  });

  // Initial seed inserts 3 teachers, 10 lessons, and creates 2 indexes
  const firstRun = await seedModule.seedDatabase(db);
  assert.equal(firstRun.reset, false);
  assert.equal(firstRun.teachers.inserted, 3);
  assert.equal(firstRun.lessons.inserted, 10);
  assert.equal(firstRun.indexes.every((idx) => idx.created === true), true);
  assert.deepEqual(
    firstRun.indexes.map((i) => i.name),
    ['idx_order_items_lessonId', 'idx_teacher_lessonIds']
  );

  // Simulate live usage mutations and existing order record
  const mathsLesson = store.collections.lesson.find((l) => l._id.equals(seedModule.lessonIds.maths));
  mathsLesson.space = 2;
  mathsLesson.topic = 'Maths Honours';
  store.collections.order.push(existingOrder);

  // Safe re-run ($setOnInsert): zero insertions/overwrites, live changes preserved, indexes skipped cleanly
  const secondRun = await seedModule.seedDatabase(db);
  assert.equal(secondRun.teachers.inserted, 0);
  assert.equal(secondRun.teachers.modified, 0);
  assert.equal(secondRun.lessons.inserted, 0);
  assert.equal(secondRun.lessons.modified, 0);
  assert.equal(secondRun.indexes.every((idx) => idx.created === false), true);
  assert.equal(store.createdIndexes.length, 2);

  assert.equal(store.collections.lesson.find((l) => l._id.equals(seedModule.lessonIds.maths)).space, 2);
  assert.equal(store.collections.lesson.find((l) => l._id.equals(seedModule.lessonIds.maths)).topic, 'Maths Honours');
  assert.equal(store.collections.order.length, 1);

  // Explicit --reset restores seeded defaults without deleting existing order data
  const resetRun = await seedModule.seedDatabase(db, { reset: true });
  assert.equal(resetRun.reset, true);
  assert.equal(store.collections.lesson.find((l) => l._id.equals(seedModule.lessonIds.maths)).space, 5);
  assert.equal(store.collections.lesson.find((l) => l._id.equals(seedModule.lessonIds.maths)).topic, 'Maths');
  assert.equal(store.collections.order.length, 1);
});

test('ensureIndexes skips equivalent pre-existing indexes even when differently named', async () => {
  const { db, store } = createMockMongo({
    indexes: {
      order: [
        { v: 2, key: { _id: 1 }, name: '_id_' },
        { v: 2, key: { 'items.lessonId': 1 }, name: 'custom_legacy_order_idx' }
      ],
      teacher: [
        { v: 2, key: { _id: 1 }, name: '_id_' },
        { v: 2, key: { lessonIds: 1 }, name: 'custom_legacy_teacher_idx' }
      ]
    }
  });

  const result = await seedModule.ensureIndexes(db);
  assert.equal(result.every((idx) => idx.created === false), true);
  assert.deepEqual(
    result.map((idx) => idx.name),
    ['custom_legacy_order_idx', 'custom_legacy_teacher_idx']
  );
  assert.equal(store.createdIndexes.length, 0);
});

test('seed.run rejects missing mongoUri and always closes injected client', async () => {
  await assert.rejects(
    () => seedModule.run({ mongoUri: '' }),
    /MONGODB_URI is not defined/
  );

  const okMock = createMockMongo();
  const origConsoleLog = console.log;
  console.log = () => {};
  try {
    const summary = await seedModule.run({
      mongoUri: 'mongodb://mock-cluster/seed_db',
      dbName: 'custom_seed_db',
      argv: [],
      createClient: () => okMock.client
    });
    assert.equal(summary.lessons.inserted, 10);
    assert.equal(okMock.stats.lastDbName, 'custom_seed_db');
    assert.equal(okMock.stats.connectCalls, 1);
    assert.equal(okMock.stats.closeCalls, 1);
  } finally {
    console.log = origConsoleLog;
  }

  // Client closes even when connect fails or throws after connect
  const failMock = createMockMongo(
    {},
    {
      onConnect: async () => {
        throw new Error('Seed connect refused');
      }
    }
  );
  await assert.rejects(
    () =>
      seedModule.run({
        mongoUri: 'mongodb://mock-cluster/seed_db',
        createClient: () => failMock.client
      }),
    /Seed connect refused/
  );
  assert.equal(failMock.stats.closeCalls, 1);
});

