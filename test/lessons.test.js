const test = require('node:test');
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');

const { createApp } = require('../app');
const {
  escapeRegex,
  fetchAllLessons,
  buildLessonSearchFilter,
  searchLessons
} = require('../services/lessons');
const { createMockMongo } = require('./helpers/mock-db');
const { sendAppRequest } = require('./helpers/http-client');

function seedSampleCatalog() {
  const aliceId = new ObjectId('507f1f77bcf86cd799439011');
  const bobId = new ObjectId('507f1f77bcf86cd799439012');

  const mathsId = new ObjectId('507f1f77bcf86cd799439021');
  const scienceId = new ObjectId('507f1f77bcf86cd799439023');
  const historyId = new ObjectId('507f1f77bcf86cd799439024');

  const teachers = [
    { _id: aliceId, name: 'Alice Smith', lessonIds: [mathsId] },
    { _id: bobId, name: 'Bob Jones', lessonIds: [scienceId, historyId] }
  ];

  const lessons = [
    { _id: mathsId, topic: 'Maths (101)', location: 'Room 101', price: 10, space: 5, image: 'maths.png', teacherId: aliceId },
    { _id: scienceId, topic: 'Science', location: 'Lab 3', price: 12, space: 4, image: 'science.png', teacherId: bobId },
    { _id: historyId, topic: 'History', location: 'Room 301', price: 15, space: 7, image: 'history.png', teacherId: bobId }
  ];

  const orders = [
    {
      _id: new ObjectId('507f1f77bcf86cd799439091'),
      status: 'pending',
      items: [
        { lessonId: mathsId, space: 2, confirmed: true },
        { lessonId: scienceId, space: 1, confirmed: false }
      ]
    },
    {
      _id: new ObjectId('507f1f77bcf86cd799439092'),
      status: 'confirmed',
      items: [
        // Legacy order item without explicit confirmed field should count toward enrolment
        { lessonId: mathsId, space: 1 }
      ]
    },
    {
      _id: new ObjectId('507f1f77bcf86cd799439093'),
      status: 'cancelled',
      items: [
        { lessonId: mathsId, space: 3, confirmed: false, cancelled: true }
      ]
    }
  ];

  return { aliceId, bobId, mathsId, scienceId, historyId, teachers, lessons, orders };
}

test('services/lessons helpers escape regex, build multi-attribute filters, and avoid unnecessary teacher queries', async () => {
  assert.equal(escapeRegex('a+b*(c)?[1]\\d'), 'a\\+b\\*\\(c\\)\\?\\[1\\]\\\\d');

  const { aliceId, bobId, teachers, lessons } = seedSampleCatalog();
  const { db, stats } = createMockMongo(
    { teachers, lessons },
    { allowedCollections: ['lesson'] }
  );

  const all = await fetchAllLessons(db);
  assert.equal(all.length, 3);

  const emptySearch = await searchLessons(db, '');
  assert.equal(emptySearch.length, 3);

  // Regular search must NOT add teacherId ObjectId equality clause
  const plainFilter = buildLessonSearchFilter('Science');
  assert.equal(
    plainFilter.$or.some((clause) => Object.prototype.hasOwnProperty.call(clause, 'teacherId')),
    false
  );

  // Valid 24-hex ObjectId includes exact teacherId match and triggers zero teacher queries
  const teacherFilter = buildLessonSearchFilter(aliceId.toHexString());
  assert.equal(
    teacherFilter.$or.some((clause) => clause.teacherId && clause.teacherId.equals(aliceId)),
    true
  );

  const bobLessons = await searchLessons(db, bobId.toHexString());
  assert.deepEqual(
    bobLessons.map((l) => l.topic),
    ['Science', 'History']
  );
  assert.equal(stats.reads.teacher || 0, 0);
});

test('GET /lessons and GET /lessons/search handle empty queries, validation, attributes, escaping, and teacherId matching', async () => {
  const { aliceId, bobId, teachers, lessons } = seedSampleCatalog();
  const { db, client, stats } = createMockMongo({ teachers, lessons });
  const app = createApp({ db, client, corsOrigin: '*' });

  const allRes = await sendAppRequest(app, 'GET', '/lessons');
  assert.equal(allRes.status, 200);
  assert.equal(allRes.json.length, 3);

  // Missing, empty, and whitespace-only queries return all lessons
  for (const path of ['/lessons/search', '/lessons/search?q=', '/lessons/search?q=%20%20%20']) {
    const res = await sendAppRequest(app, 'GET', path);
    assert.equal(res.status, 200);
    assert.equal(res.json.length, 3);
  }

  // Repeated q parameter (?q=a&q=b -> Express array) and >100 chars return 400
  const multiQRes = await sendAppRequest(app, 'GET', '/lessons/search?q=Maths&q=Science');
  assert.equal(multiQRes.status, 400);
  assert.equal(multiQRes.json.error, 'Invalid query parameter');

  const longQRes = await sendAppRequest(app, 'GET', `/lessons/search?q=${'x'.repeat(101)}`);
  assert.equal(longQRes.status, 400);
  assert.equal(longQRes.json.error, 'Query too long');

  // Case-insensitive attribute matches across topic, location, image, price, space, regex characters, teacherId
  const byTopic = await sendAppRequest(app, 'GET', '/lessons/search?q=mAtHs');
  assert.deepEqual(byTopic.json.map((l) => l.topic), ['Maths (101)']);

  const byLocation = await sendAppRequest(app, 'GET', '/lessons/search?q=lab%203');
  assert.deepEqual(byLocation.json.map((l) => l.topic), ['Science']);

  const byImage = await sendAppRequest(app, 'GET', '/lessons/search?q=HISTORY.PNG');
  assert.deepEqual(byImage.json.map((l) => l.topic), ['History']);

  const byPrice = await sendAppRequest(app, 'GET', '/lessons/search?q=12');
  assert.deepEqual(byPrice.json.map((l) => l.topic), ['Science']);

  const bySpace = await sendAppRequest(app, 'GET', '/lessons/search?q=7');
  assert.deepEqual(bySpace.json.map((l) => l.topic), ['History']);

  const escapedParens = await sendAppRequest(app, 'GET', '/lessons/search?q=(101)');
  assert.deepEqual(escapedParens.json.map((l) => l.topic), ['Maths (101)']);

  // Literal regex metacharacter should NOT behave as wildcard ('.*' shouldn't match everything)
  const regexBomb = await sendAppRequest(app, 'GET', '/lessons/search?q=.*');
  assert.equal(regexBomb.status, 200);
  assert.equal(regexBomb.json.length, 0);

  const byTeacherId = await sendAppRequest(app, 'GET', `/lessons/search?q=${bobId.toHexString()}`);
  assert.deepEqual(byTeacherId.json.map((l) => l.topic), ['Science', 'History']);

  // Malformed 24-char non-hex query stays safe literal text search
  const nonHex24 = await sendAppRequest(app, 'GET', `/lessons/search?q=${'g'.repeat(24)}`);
  assert.equal(nonHex24.status, 200);
  assert.equal(nonHex24.json.length, 0);

  // Teacher collection should never be queried during lesson endpoints
  assert.equal(stats.reads.teacher || 0, 0);
  assert.equal(stats.findOnes.teacher || 0, 0);
  assert.equal(aliceId.toHexString().length, 24);
});

test('GET /teachers, GET /teachers/:id/lessons, and GET /enrolment/:lessonid handle data, empty sets, confirmed sums, and errors', async () => {
  const { aliceId, bobId, mathsId, scienceId, teachers, lessons, orders } = seedSampleCatalog();
  const emptyTeacherId = new ObjectId('507f1f77bcf86cd799439019');
  teachers.push({ _id: emptyTeacherId, name: 'No Lessons Yet', lessonIds: [] });

  const { db, client } = createMockMongo({ teachers, lessons, orders });
  const app = createApp({ db, client, corsOrigin: '*' });

  const teachersRes = await sendAppRequest(app, 'GET', '/teachers');
  assert.equal(teachersRes.status, 200);
  assert.equal(teachersRes.json.length, 3);

  const bobLessonsRes = await sendAppRequest(app, 'GET', `/teachers/${bobId.toHexString()}/lessons`);
  assert.equal(bobLessonsRes.status, 200);
  assert.deepEqual(bobLessonsRes.json.map((l) => l.topic), ['Science', 'History']);

  const aliceLessonsRes = await sendAppRequest(app, 'GET', `/teachers/${aliceId.toHexString()}/lessons`);
  assert.equal(aliceLessonsRes.status, 200);
  assert.deepEqual(aliceLessonsRes.json.map((l) => l.topic), ['Maths (101)']);

  const emptyTeacherRes = await sendAppRequest(app, 'GET', `/teachers/${emptyTeacherId.toHexString()}/lessons`);
  assert.equal(emptyTeacherRes.status, 200);
  assert.deepEqual(emptyTeacherRes.json, []);

  const badTeacherRes = await sendAppRequest(app, 'GET', '/teachers/bad-id/lessons');
  assert.equal(badTeacherRes.status, 400);

  const missingTeacherRes = await sendAppRequest(app, 'GET', `/teachers/${new ObjectId().toHexString()}/lessons`);
  assert.equal(missingTeacherRes.status, 404);

  // Enrolment sums confirmed (2) + legacy (1) = 3, excluding unconfirmed/cancelled (3)
  const mathsEnrolRes = await sendAppRequest(app, 'GET', `/enrolment/${mathsId.toHexString()}`);
  assert.equal(mathsEnrolRes.status, 200);
  assert.deepEqual(mathsEnrolRes.json, {
    success: true,
    lessonId: mathsId.toHexString(),
    totalEnrolled: 3
  });

  // Unconfirmed-only lesson shows totalEnrolled = 0
  const scienceEnrolRes = await sendAppRequest(app, 'GET', `/enrolment/${scienceId.toHexString()}`);
  assert.equal(scienceEnrolRes.status, 200);
  assert.equal(scienceEnrolRes.json.totalEnrolled, 0);

  const badEnrolIdRes = await sendAppRequest(app, 'GET', '/enrolment/invalid-id');
  assert.equal(badEnrolIdRes.status, 400);

  const missingLessonEnrolRes = await sendAppRequest(app, 'GET', `/enrolment/${new ObjectId().toHexString()}`);
  assert.equal(missingLessonEnrolRes.status, 404);
});
