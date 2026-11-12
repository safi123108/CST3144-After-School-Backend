/**
 * Seed initial teachers and lessons and ensure useful MongoDB indexes.
 *
 * Safe default (`node seed.js`):
 *   Inserts missing teachers/lessons with `$setOnInsert` so live lesson
 *   spaces, assignments, and order history are preserved on re-runs.
 *
 * Explicit reset (`node seed.js --reset`):
 *   Restores seeded teachers and lessons (including `space: 5`) via `$set`
 *   without deleting orders or user data.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { MongoClient, ObjectId } = require('mongodb');

const DEFAULT_DB_NAME = 'after_school_app';

// Fixed predefined ObjectIds for teachers (3 teachers)
const teacherIds = {
  alice: new ObjectId('507f1f77bcf86cd799439011'),
  bob: new ObjectId('507f1f77bcf86cd799439012'),
  carol: new ObjectId('507f1f77bcf86cd799439013'),
};

// Fixed predefined ObjectIds for lessons (10 lessons)
const lessonIds = {
  maths: new ObjectId('507f1f77bcf86cd799439021'),
  english: new ObjectId('507f1f77bcf86cd799439022'),
  science: new ObjectId('507f1f77bcf86cd799439023'),
  history: new ObjectId('507f1f77bcf86cd799439024'),
  geography: new ObjectId('507f1f77bcf86cd799439025'),
  art: new ObjectId('507f1f77bcf86cd799439026'),
  music: new ObjectId('507f1f77bcf86cd799439027'),
  pe: new ObjectId('507f1f77bcf86cd799439028'),
  drama: new ObjectId('507f1f77bcf86cd799439029'),
  french: new ObjectId('507f1f77bcf86cd799439030'),
};

// Map each lesson to a teacher
const lessonTeacherMap = {
  maths: 'alice',
  english: 'alice',
  science: 'bob',
  history: 'bob',
  geography: 'carol',
  art: 'carol',
  music: 'alice',
  pe: 'bob',
  drama: 'carol',
  french: 'alice',
};

// Build teacher lessonIds arrays from the lesson-to-teacher map
const teacherLessonIds = {};
for (const [lessonKey, teacherKey] of Object.entries(lessonTeacherMap)) {
  if (!teacherLessonIds[teacherKey]) {
    teacherLessonIds[teacherKey] = [];
  }
  teacherLessonIds[teacherKey].push(lessonIds[lessonKey]);
}

// Teacher documents with fixed ObjectIds and matching lessonIds arrays
const teachers = [
  { _id: teacherIds.alice, name: 'Alice Smith', lessonIds: teacherLessonIds.alice || [] },
  { _id: teacherIds.bob, name: 'Bob Jones', lessonIds: teacherLessonIds.bob || [] },
  { _id: teacherIds.carol, name: 'Carol White', lessonIds: teacherLessonIds.carol || [] },
];

// Lesson documents with fixed ObjectIds, space: 5, and teacherId referencing an existing teacher
const lessons = [
  { _id: lessonIds.maths, topic: 'Maths', location: 'Room 101', price: 10, space: 5, image: 'maths.png', teacherId: teacherIds.alice },
  { _id: lessonIds.english, topic: 'English', location: 'Room 102', price: 10, space: 5, image: 'english.png', teacherId: teacherIds.alice },
  { _id: lessonIds.science, topic: 'Science', location: 'Lab 3', price: 12, space: 5, image: 'science.png', teacherId: teacherIds.bob },
  { _id: lessonIds.history, topic: 'History', location: 'Room 201', price: 10, space: 5, image: 'history.png', teacherId: teacherIds.bob },
  { _id: lessonIds.geography, topic: 'Geography', location: 'Room 202', price: 10, space: 5, image: 'geography.png', teacherId: teacherIds.carol },
  { _id: lessonIds.art, topic: 'Art', location: 'Studio A', price: 15, space: 5, image: 'art.png', teacherId: teacherIds.carol },
  { _id: lessonIds.music, topic: 'Music', location: 'Studio B', price: 15, space: 5, image: 'music.png', teacherId: teacherIds.alice },
  { _id: lessonIds.pe, topic: 'PE', location: 'Gym', price: 8, space: 5, image: 'pe.png', teacherId: teacherIds.bob },
  { _id: lessonIds.drama, topic: 'Drama', location: 'Theatre', price: 12, space: 5, image: 'drama.png', teacherId: teacherIds.carol },
  { _id: lessonIds.french, topic: 'French', location: 'Room 301', price: 10, space: 5, image: 'french.png', teacherId: teacherIds.alice },
];

const INDEX_DEFINITIONS = [
  {
    collection: 'order',
    keys: { 'items.lessonId': 1 },
    options: { name: 'idx_order_items_lessonId' }
  },
  {
    collection: 'teacher',
    keys: { lessonIds: 1 },
    options: { name: 'idx_teacher_lessonIds' }
  }
];

function parseSeedOptions(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? argv : [];
  return {
    reset: args.includes('--reset')
  };
}

function hasSameKeySpec(existingKeys, targetKeys) {
  const existingEntries = Object.entries(existingKeys || {});
  const targetEntries = Object.entries(targetKeys || {});
  if (existingEntries.length !== targetEntries.length) {
    return false;
  }
  return existingEntries.every(
    ([key, dir], index) => targetEntries[index][0] === key && targetEntries[index][1] === dir
  );
}

/**
 * Create essential query indexes while skipping indexes whose key spec already exists.
 */
async function ensureIndexes(db) {
  const results = [];

  for (const def of INDEX_DEFINITIONS) {
    const col = db.collection(def.collection);
    let existing = [];

    if (typeof col.indexes === 'function') {
      try {
        existing = await col.indexes();
      } catch (err) {
        // NamespaceNotFound (code 26) occurs before a collection exists on MongoDB.
        if (err && err.code !== 26) {
          throw err;
        }
      }
    }

    const alreadyPresent = existing.find(
      (idx) => idx && (idx.name === def.options.name || hasSameKeySpec(idx.key, def.keys))
    );

    if (alreadyPresent) {
      results.push({
        collection: def.collection,
        name: alreadyPresent.name || def.options.name,
        created: false
      });
      continue;
    }

    const indexName = await col.createIndex(def.keys, def.options);
    results.push({
      collection: def.collection,
      name: indexName || def.options.name,
      created: true
    });
  }

  return results;
}

async function upsertSeedCollection(collection, documents, reset) {
  let inserted = 0;
  let modified = 0;
  let matched = 0;

  for (const doc of documents) {
    const updateOperator = reset ? { $set: doc } : { $setOnInsert: doc };
    const res = await collection.updateOne(
      { _id: doc._id },
      updateOperator,
      { upsert: true }
    );
    inserted += res && res.upsertedCount ? res.upsertedCount : 0;
    modified += res && res.modifiedCount ? res.modifiedCount : 0;
    matched += res && res.matchedCount ? res.matchedCount : 0;
  }

  return { inserted, modified, matched, total: documents.length };
}

/**
 * Seed teachers/lessons safely (or reset them when options.reset is true) and ensure indexes.
 */
async function seedDatabase(db, options = {}) {
  const reset = Boolean(options.reset);
  const teacherStats = await upsertSeedCollection(db.collection('teacher'), teachers, reset);
  const lessonStats = await upsertSeedCollection(db.collection('lesson'), lessons, reset);
  const indexes = await ensureIndexes(db);

  return {
    reset,
    teachers: teacherStats,
    lessons: lessonStats,
    indexes
  };
}

async function run(options = {}) {
  const mongoUri = options.mongoUri ?? process.env.MONGODB_URI;
  const dbName = options.dbName ?? process.env.DB_NAME ?? DEFAULT_DB_NAME;
  const seedOptions = options.argv ? parseSeedOptions(options.argv) : { reset: Boolean(options.reset) };
  const createClient =
    typeof options.createClient === 'function'
      ? options.createClient
      : (uri) => new MongoClient(uri);

  if (!mongoUri) {
    throw new Error('MONGODB_URI is not defined in environment variables.');
  }

  const client = createClient(mongoUri);
  try {
    await client.connect();
    const db = client.db(dbName);
    const summary = await seedDatabase(db, seedOptions);
    const modeLabel = summary.reset ? 'reset (--reset)' : 'safe ($setOnInsert)';
    console.log(
      `Seed complete [${modeLabel}]: ` +
      `${summary.teachers.inserted} teacher(s) inserted, ${summary.teachers.modified} updated; ` +
      `${summary.lessons.inserted} lesson(s) inserted, ${summary.lessons.modified} updated.`
    );
    return summary;
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  run({ argv: process.argv.slice(2) }).catch((error) => {
    console.error('Seed error:', error.message);
    process.exit(1);
  });
}

module.exports = {
  teacherIds,
  lessonIds,
  teachers,
  lessons,
  INDEX_DEFINITIONS,
  parseSeedOptions,
  ensureIndexes,
  seedDatabase,
  run
};
