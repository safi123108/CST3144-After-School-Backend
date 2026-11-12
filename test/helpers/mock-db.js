const { ObjectId } = require('mongodb');

function cloneValue(value) {
  if (value instanceof ObjectId) {
    return new ObjectId(value.toHexString());
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }
  if (value && typeof value === 'object') {
    const copy = {};
    for (const [k, v] of Object.entries(value)) {
      copy[k] = cloneValue(v);
    }
    return copy;
  }
  return value;
}

function valuesEqual(a, b) {
  if (a instanceof ObjectId && b instanceof ObjectId) {
    return a.equals(b);
  }
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  return a === b;
}

function matchesExprRegex(doc, regexMatchSpec) {
  if (!regexMatchSpec || typeof regexMatchSpec !== 'object') {
    return false;
  }
  const inputSpec = regexMatchSpec.input;
  let fieldName = null;
  if (inputSpec && Array.isArray(inputSpec.$ifNull) && inputSpec.$ifNull[0] && inputSpec.$ifNull[0].$toString) {
    const ref = inputSpec.$ifNull[0].$toString;
    if (typeof ref === 'string' && ref.startsWith('$')) {
      fieldName = ref.slice(1);
    }
  }
  if (!fieldName) {
    return false;
  }
  const raw = doc[fieldName];
  const text = raw === undefined || raw === null ? '' : String(raw);
  const re = new RegExp(regexMatchSpec.regex, regexMatchSpec.options || '');
  return re.test(text);
}

function matchesCondition(doc, key, expected) {
  if (key === '$or' && Array.isArray(expected)) {
    return expected.some((subFilter) => matchesFilter(doc, subFilter));
  }
  if (key === '$expr' && expected && expected.$regexMatch) {
    return matchesExprRegex(doc, expected.$regexMatch);
  }

  // Dot-notation array element matching (e.g. 'items.lessonId')
  if (key.includes('.')) {
    const parts = key.split('.');
    let current = doc;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (Array.isArray(current)) {
        const remainingKey = parts.slice(i).join('.');
        return current.some((el) => el && typeof el === 'object' && matchesCondition(el, remainingKey, expected));
      }
      if (!current || typeof current !== 'object') {
        return false;
      }
      current = current[part];
    }
    if (expected && typeof expected === 'object' && Array.isArray(expected.$in)) {
      return expected.$in.some((candidate) => valuesEqual(current, candidate));
    }
    return valuesEqual(current, expected);
  }

  const actual = doc[key];
  if (expected && typeof expected === 'object' && !(expected instanceof ObjectId) && !(expected instanceof Date)) {
    if (Array.isArray(expected.$in)) {
      return expected.$in.some((candidate) => valuesEqual(actual, candidate));
    }
    if (expected.$regex instanceof RegExp) {
      return typeof actual === 'string' && expected.$regex.test(actual);
    }
  }
  return valuesEqual(actual, expected);
}

function matchesFilter(doc, filter = {}) {
  if (!filter || typeof filter !== 'object') {
    return true;
  }
  return Object.entries(filter).every(([key, expected]) => matchesCondition(doc, key, expected));
}

function createCollectionWrapper(store, name, hooks, stats) {
  const getDocs = () => {
    if (!store.collections[name]) {
      store.collections[name] = [];
    }
    return store.collections[name];
  };

  return {
    find(filter = {}) {
      return {
        async toArray() {
          stats.reads[name] = (stats.reads[name] || 0) + 1;
          stats.lastFilters[name] = filter;
          if (hooks.onFind) {
            const override = await hooks.onFind(name, filter);
            if (override !== undefined) return cloneValue(override);
          }
          return cloneValue(getDocs().filter((doc) => matchesFilter(doc, filter)));
        }
      };
    },

    async findOne(filter = {}, options = {}) {
      stats.findOnes[name] = (stats.findOnes[name] || 0) + 1;
      if (hooks.onFindOne) {
        const override = await hooks.onFindOne(name, filter, options);
        if (override !== undefined) return cloneValue(override);
      }
      const found = getDocs().find((doc) => matchesFilter(doc, filter));
      return found ? cloneValue(found) : null;
    },

    async insertOne(doc, options = {}) {
      if (hooks.onInsertOne) {
        await hooks.onInsertOne(name, doc, options);
      }
      const copy = cloneValue(doc);
      if (!copy._id) {
        copy._id = new ObjectId();
      }
      getDocs().push(copy);
      return {
        acknowledged: true,
        insertedId: cloneValue(copy._id)
      };
    },

    async updateOne(filter = {}, update = {}, options = {}) {
      if (hooks.onUpdateOne) {
        const override = await hooks.onUpdateOne(name, filter, update, options);
        if (override !== undefined) return override;
      }

      const docs = getDocs();
      const idx = docs.findIndex((doc) => matchesFilter(doc, filter));

      if (idx === -1) {
        if (options && options.upsert) {
          const inserted = {};
          if (filter && filter._id) {
            inserted._id = cloneValue(filter._id);
          }
          if (update.$setOnInsert) {
            Object.assign(inserted, cloneValue(update.$setOnInsert));
          }
          if (update.$set) {
            Object.assign(inserted, cloneValue(update.$set));
          }
          if (!inserted._id) {
            inserted._id = new ObjectId();
          }
          docs.push(inserted);
          return {
            matchedCount: 0,
            modifiedCount: 0,
            upsertedCount: 1,
            upsertedId: cloneValue(inserted._id)
          };
        }
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      }

      const target = docs[idx];
      let modified = 0;

      if (update.$set) {
        for (const [k, v] of Object.entries(update.$set)) {
          if (k === 'items.$.confirmed' || k === 'items.$.cancelled') {
            const prop = k.split('.').pop();
            const targetLessonId = filter['items.lessonId'];
            if (Array.isArray(target.items)) {
              const item = target.items.find((entry) => entry && entry.lessonId && valuesEqual(entry.lessonId, targetLessonId));
              if (item) {
                item[prop] = cloneValue(v);
                modified = 1;
              }
            }
          } else {
            target[k] = cloneValue(v);
            modified = 1;
          }
        }
      }

      if (update.$pull) {
        for (const [field, val] of Object.entries(update.$pull)) {
          if (Array.isArray(target[field])) {
            const prevLen = target[field].length;
            target[field] = target[field].filter((entry) => !valuesEqual(entry, val));
            if (target[field].length !== prevLen) {
              modified = 1;
            }
          }
        }
      }

      if (update.$addToSet) {
        for (const [field, val] of Object.entries(update.$addToSet)) {
          if (!Array.isArray(target[field])) {
            target[field] = [];
          }
          if (!target[field].some((entry) => valuesEqual(entry, val))) {
            target[field].push(cloneValue(val));
            modified = 1;
          }
        }
      }

      // $setOnInsert only runs when inserting a new document, so matching existing rows leaves them unchanged
      return { matchedCount: 1, modifiedCount: modified, upsertedCount: 0 };
    },

    async indexes() {
      if (hooks.onIndexes) {
        return cloneValue(await hooks.onIndexes(name));
      }
      const docs = store.collections[name];
      if (store.missingNamespaces.has(name) && (!docs || docs.length === 0) && !store.indexes[name]) {
        const err = new Error(`ns does not exist: ${name}`);
        err.code = 26;
        throw err;
      }
      if (!store.indexes[name]) {
        store.indexes[name] = [{ v: 2, key: { _id: 1 }, name: '_id_' }];
      }
      return cloneValue(store.indexes[name]);
    },

    async createIndex(keys, options = {}) {
      if (hooks.onCreateIndex) {
        return hooks.onCreateIndex(name, keys, options);
      }
      store.missingNamespaces.delete(name);
      if (!store.indexes[name]) {
        store.indexes[name] = [{ v: 2, key: { _id: 1 }, name: '_id_' }];
      }
      const indexName = options.name || Object.keys(keys).map((k) => `${k}_1`).join('_');
      store.indexes[name].push({ v: 2, key: cloneValue(keys), name: indexName });
      store.createdIndexes.push({ collection: name, keys: cloneValue(keys), name: indexName });
      return indexName;
    }
  };
}

/**
 * Create an isolated in-memory mock MongoDB store, db handle, and transactional client.
 */
function createMockMongo(initialState = {}, hooks = {}) {
  const store = {
    collections: {
      lesson: cloneValue(initialState.lessons || []),
      teacher: cloneValue(initialState.teachers || []),
      order: cloneValue(initialState.orders || [])
    },
    indexes: cloneValue(initialState.indexes || {}),
    missingNamespaces: new Set(initialState.missingNamespaces || []),
    createdIndexes: []
  };

  const stats = {
    reads: {},
    findOnes: {},
    lastFilters: {},
    connectCalls: 0,
    closeCalls: 0,
    sessionsStarted: 0,
    sessionsEnded: 0,
    commits: 0,
    rollbacks: 0
  };

  const db = {
    collection(name) {
      if (hooks.allowedCollections && !hooks.allowedCollections.includes(name)) {
        throw new Error(`Unexpected collection access: ${name}`);
      }
      return createCollectionWrapper(store, name, hooks, stats);
    }
  };

  const client = {
    async connect() {
      stats.connectCalls += 1;
      if (hooks.onConnect) {
        await hooks.onConnect();
      }
    },
    db(dbName) {
      stats.lastDbName = dbName;
      return db;
    },
    startSession() {
      stats.sessionsStarted += 1;
      return {
        async withTransaction(work) {
          const snapshot = cloneValue(store.collections);
          try {
            const res = await work();
            stats.commits += 1;
            return res;
          } catch (err) {
            store.collections = snapshot;
            stats.rollbacks += 1;
            throw err;
          }
        },
        async endSession() {
          stats.sessionsEnded += 1;
        }
      };
    },
    async close() {
      stats.closeCalls += 1;
      if (hooks.onClose) {
        await hooks.onClose();
      }
    }
  };

  return { store, stats, db, client, cloneValue };
}

module.exports = {
  createMockMongo,
  cloneValue,
  valuesEqual
};
