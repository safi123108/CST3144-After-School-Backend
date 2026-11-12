const { ObjectId } = require('mongodb');

/**
 * Escape regex special characters so user search queries are matched literally.
 */
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Retrieve all lesson documents from the "lesson" collection.
 */
async function fetchAllLessons(db) {
  return db.collection('lesson').find({}).toArray();
}

/**
 * Build a case-insensitive MongoDB filter matching relevant lesson attributes.
 * Matches string attributes (topic, location, image), stringified numeric attributes
 * (price, space), and exact 24-character hexadecimal teacher ObjectIds without
 * issuing extra database queries.
 */
function buildLessonSearchFilter(query) {
  const escaped = escapeRegex(query);
  const regex = new RegExp(escaped, 'i');

  const orClauses = [
    { topic: { $regex: regex } },
    { location: { $regex: regex } },
    { image: { $regex: regex } },
    {
      $expr: {
        $regexMatch: {
          input: { $ifNull: [{ $toString: '$price' }, ''] },
          regex: escaped,
          options: 'i'
        }
      }
    },
    {
      $expr: {
        $regexMatch: {
          input: { $ifNull: [{ $toString: '$space' }, ''] },
          regex: escaped,
          options: 'i'
        }
      }
    }
  ];

  if (/^[a-fA-F0-9]{24}$/.test(query) && ObjectId.isValid(query)) {
    orClauses.push({ teacherId: new ObjectId(query) });
  }

  return { $or: orClauses };
}

/**
 * Search lessons by trimmed query string, or return all lessons when empty.
 */
async function searchLessons(db, query) {
  if (!query) {
    return fetchAllLessons(db);
  }
  const filter = buildLessonSearchFilter(query);
  return db.collection('lesson').find(filter).toArray();
}

module.exports = {
  escapeRegex,
  fetchAllLessons,
  buildLessonSearchFilter,
  searchLessons
};

