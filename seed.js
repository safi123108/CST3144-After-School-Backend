const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { MongoClient, ObjectId } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'after_school_app';

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

async function run() {
  if (!MONGODB_URI) {
    console.error('Error: MONGODB_URI is not defined in environment variables.');
    process.exit(1);
  }

  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();
    const db = client.db(DB_NAME);

    // Upsert teachers: updates existing or inserts new, never creates duplicates
    for (const teacher of teachers) {
      await db.collection('teacher').updateOne(
        { _id: teacher._id },
        { $set: teacher },
        { upsert: true }
      );
    }

    // Upsert lessons: updates existing or inserts new, never creates duplicates
    for (const lesson of lessons) {
      await db.collection('lesson').updateOne(
        { _id: lesson._id },
        { $set: lesson },
        { upsert: true }
      );
    }

    console.log(`Seeded ${teachers.length} teachers and ${lessons.length} lessons.`);
  } catch (error) {
    console.error('Seed error:', error.message);
    process.exit(1);
  } finally {
    await client.close();
  }
}

run();
