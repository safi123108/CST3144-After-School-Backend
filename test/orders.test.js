const test = require('node:test');
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');

const { createApp } = require('../app');
const { createMockMongo } = require('./helpers/mock-db');
const { sendAppRequest } = require('./helpers/http-client');

function createCatalogState() {
  const teacherAliceId = new ObjectId('507f1f77bcf86cd799439011');
  const teacherBobId = new ObjectId('507f1f77bcf86cd799439012');
  const lessonMathsId = new ObjectId('507f1f77bcf86cd799439021');
  const lessonEnglishId = new ObjectId('507f1f77bcf86cd799439022');

  return {
    teacherAliceId,
    teacherBobId,
    lessonMathsId,
    lessonEnglishId,
    teachers: [
      { _id: teacherAliceId, name: 'Alice Smith', lessonIds: [lessonMathsId, lessonEnglishId] },
      { _id: teacherBobId, name: 'Bob Jones', lessonIds: [] }
    ],
    lessons: [
      { _id: lessonMathsId, topic: 'Maths', location: 'Room 101', price: 10, space: 5, image: 'maths.png', teacherId: teacherAliceId },
      { _id: lessonEnglishId, topic: 'English', location: 'Room 102', price: 12, space: 4, image: 'english.png', teacherId: teacherAliceId }
    ],
    orders: []
  };
}

test('POST /orders validates fields, consolidates duplicates, enforces stock, and creates pending order without decrementing space', async () => {
  const state = createCatalogState();
  const { db, client, store } = createMockMongo(state);
  const app = createApp({ db, client, corsOrigin: '*' });

  const mathsHex = state.lessonMathsId.toHexString();
  const englishHex = state.lessonEnglishId.toHexString();

  // Invalid customer name, phone, and item shapes
  const badName = await sendAppRequest(app, 'POST', '/orders', {
    jsonBody: { name: 'Alex 123', phone: '07123456789', items: [{ lessonId: mathsHex, space: 1 }] }
  });
  assert.equal(badName.status, 400);
  assert.equal(badName.json.error, 'Invalid name');

  const badPhone = await sendAppRequest(app, 'POST', '/orders', {
    jsonBody: { name: 'Alex Smith', phone: '0712-abc', items: [{ lessonId: mathsHex, space: 1 }] }
  });
  assert.equal(badPhone.status, 400);
  assert.equal(badPhone.json.error, 'Invalid phone');

  const zeroSpace = await sendAppRequest(app, 'POST', '/orders', {
    jsonBody: { name: 'Alex Smith', phone: '07123456789', items: [{ lessonId: mathsHex, space: 0 }] }
  });
  assert.equal(zeroSpace.status, 400);
  assert.equal(zeroSpace.json.error, 'Invalid space');

  // Missing lesson returns 404
  const missingLesson = await sendAppRequest(app, 'POST', '/orders', {
    jsonBody: { name: 'Alex Smith', phone: '07123456789', items: [{ lessonId: new ObjectId().toHexString(), space: 1 }] }
  });
  assert.equal(missingLesson.status, 404);
  assert.equal(missingLesson.json.error, 'Lesson not found');

  // Duplicate lessonId sum exceeding stock (3 + 3 = 6 > 5) returns 409
  const overStock = await sendAppRequest(app, 'POST', '/orders', {
    jsonBody: {
      name: 'Alex Smith',
      phone: '07123456789',
      items: [
        { lessonId: mathsHex, space: 3 },
        { lessonId: mathsHex, space: 3 }
      ]
    }
  });
  assert.equal(overStock.status, 409);
  assert.equal(overStock.json.error, 'Insufficient spaces');

  // Valid order consolidates duplicate items and preserves lesson.space until PUT confirmation
  const validRes = await sendAppRequest(app, 'POST', '/orders', {
    jsonBody: {
      name: '  Alex Smith ',
      phone: ' 07123456789 ',
      items: [
        { lessonId: mathsHex, space: 1 },
        { lessonId: mathsHex, space: 1 },
        { lessonId: englishHex, space: 1 }
      ]
    }
  });
  assert.equal(validRes.status, 201);
  assert.equal(validRes.json.success, true);
  assert.equal(validRes.json.order.name, 'Alex Smith');
  assert.equal(validRes.json.order.phone, '07123456789');
  assert.equal(validRes.json.order.status, 'pending');
  assert.equal(validRes.json.order.items.length, 2);
  assert.equal(validRes.json.order.items[0].space, 2);
  assert.equal(validRes.json.order.items[0].confirmed, false);
  assert.equal(store.collections.lesson[0].space, 5);
});

test('PUT /lessons/:id order confirmation enforces payload rules, idempotency, conflict checks, and rollback', async () => {
  const state = createCatalogState();
  let failOrderStatusUpdate = false;
  const { db, client, store, stats } = createMockMongo(state, {
    onUpdateOne: async (colName, filter, update) => {
      if (failOrderStatusUpdate && colName === 'order' && update.$set && update.$set.status === 'confirmed') {
        throw new Error('Simulated failure during confirmation tx');
      }
      return undefined;
    }
  });
  const app = createApp({ db, client, corsOrigin: '*' });

  const mathsHex = state.lessonMathsId.toHexString();
  const englishHex = state.lessonEnglishId.toHexString();

  // Create two-item pending order (Maths: 2, English: 1)
  const createRes = await sendAppRequest(app, 'POST', '/orders', {
    jsonBody: {
      name: 'Taylor Brown',
      phone: '07987654321',
      items: [
        { lessonId: mathsHex, space: 2 },
        { lessonId: englishHex, space: 1 }
      ]
    }
  });
  const orderId = String(createRes.json.order._id);

  // Validation checks for order confirmation branch
  const invalidPayloads = [
    [{ orderId }, 400, 'Missing space'],
    [{ orderId, space: -1 }, 400, 'Invalid data type'],
    [{ orderId, space: 1.5 }, 400, 'Invalid data type'],
    [{ orderId, space: '3' }, 400, 'Invalid data type'],
    [{ orderId, space: 3, price: 99 }, 400, 'Conflicting attributes'],
    [{ orderId: 'bad-id', space: 3 }, 400, 'Invalid data type'],
    [[], 400, 'Empty update payload']
  ];
  for (const [payload, expectedStatus, expectedError] of invalidPayloads) {
    const res = await sendAppRequest(app, 'PUT', `/lessons/${mathsHex}`, { jsonBody: payload });
    assert.equal(res.status, expectedStatus);
    assert.equal(res.json.error, expectedError);
  }

  // Wrong remaining space triggers 409 conflict without altering state
  const conflictRes = await sendAppRequest(app, 'PUT', `/lessons/${mathsHex}`, {
    jsonBody: { space: 2, orderId }
  });
  assert.equal(conflictRes.status, 409);
  assert.equal(store.collections.lesson[0].space, 5);

  // First item confirmed: lesson decrements 5 -> 3; order stays pending
  const confirmMaths = await sendAppRequest(app, 'PUT', `/lessons/${mathsHex}`, {
    jsonBody: { space: 3, orderId }
  });
  assert.equal(confirmMaths.status, 200);
  assert.equal(store.collections.lesson[0].space, 3);
  assert.equal(store.collections.order[0].status, 'pending');
  assert.equal(store.collections.order[0].items[0].confirmed, true);

  // Idempotent repeat while still pending preserves space = 3
  const repeatMaths = await sendAppRequest(app, 'PUT', `/lessons/${mathsHex}`, {
    jsonBody: { space: 3, orderId }
  });
  assert.equal(repeatMaths.status, 200);
  assert.equal(store.collections.lesson[0].space, 3);

  // Confirming second item with mid-tx failure rolls back English lesson space (4) and item confirmed (false)
  const origConsoleError = console.error;
  console.error = () => {};
  failOrderStatusUpdate = true;
  try {
    const failedConfirm = await sendAppRequest(app, 'PUT', `/lessons/${englishHex}`, {
      jsonBody: { space: 3, orderId }
    });
    assert.equal(failedConfirm.status, 500);
    assert.equal(stats.rollbacks >= 1, true);
    assert.equal(store.collections.lesson[1].space, 4);
    assert.equal(store.collections.order[0].status, 'pending');
    assert.equal(store.collections.order[0].items[1].confirmed, false);
  } finally {
    failOrderStatusUpdate = false;
    console.error = origConsoleError;
  }

  // Clean confirmation of remaining item finishes transition to status='confirmed'
  const confirmEnglish = await sendAppRequest(app, 'PUT', `/lessons/${englishHex}`, {
    jsonBody: { space: 3, orderId }
  });
  assert.equal(confirmEnglish.status, 200);
  assert.equal(store.collections.lesson[1].space, 3);
  assert.equal(store.collections.order[0].status, 'confirmed');
  assert.equal(store.collections.order[0].confirmedAt instanceof Date, true);
});

test('PUT /lessons/:id handles normal updates, immutable fields, traversal checks, and transactional teacher reassignment', async () => {
  const state = createCatalogState();
  const { db, client, store } = createMockMongo(state);
  const app = createApp({ db, client, corsOrigin: '*' });

  const mathsHex = state.lessonMathsId.toHexString();
  const bobHex = state.teacherBobId.toHexString();

  // Immutable _id and traversal image rejection
  const idRes = await sendAppRequest(app, 'PUT', `/lessons/${mathsHex}`, {
    jsonBody: { _id: new ObjectId().toHexString(), topic: 'Hacked' }
  });
  assert.equal(idRes.status, 400);
  assert.equal(idRes.json.error, 'Immutable field');

  const traversalImageRes = await sendAppRequest(app, 'PUT', `/lessons/${mathsHex}`, {
    jsonBody: { image: '../secret.png' }
  });
  assert.equal(traversalImageRes.status, 400);
  assert.equal(traversalImageRes.json.error, 'Invalid data type');

  // General attribute update
  const topicRes = await sendAppRequest(app, 'PUT', `/lessons/${mathsHex}`, {
    jsonBody: { topic: 'Advanced Maths', price: 14 }
  });
  assert.equal(topicRes.status, 200);
  assert.equal(store.collections.lesson[0].topic, 'Advanced Maths');
  assert.equal(store.collections.lesson[0].price, 14);

  // Reassign Maths from Alice to Bob atomically
  const moveRes = await sendAppRequest(app, 'PUT', `/lessons/${mathsHex}`, {
    jsonBody: { teacherId: bobHex }
  });
  assert.equal(moveRes.status, 200);
  assert.equal(store.collections.lesson[0].teacherId.equals(state.teacherBobId), true);
  assert.equal(store.collections.teacher[0].lessonIds.some((id) => id.equals(state.lessonMathsId)), false);
  assert.equal(store.collections.teacher[1].lessonIds.some((id) => id.equals(state.lessonMathsId)), true);

  // Missing target teacher returns 404 without leaving stale changes
  const badTeacherRes = await sendAppRequest(app, 'PUT', `/lessons/${mathsHex}`, {
    jsonBody: { teacherId: new ObjectId().toHexString() }
  });
  assert.equal(badTeacherRes.status, 404);
});

test('DELETE /orders/:orderId cancels atomically, rejects duplicate/confirmed cancellations, preserves partial stock, and handles conflicts/rollbacks', async () => {
  const state = createCatalogState();
  let forceConcurrentStatusChange = false;
  let forceTxCrash = false;

  const { db, client, store, stats } = createMockMongo(state, {
    onUpdateOne: async (colName, filter) => {
      if (colName === 'order' && filter.status && forceConcurrentStatusChange) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      if (colName === 'order' && forceTxCrash) {
        throw new Error('Simulated abort during DELETE tx');
      }
      return undefined;
    }
  });
  const app = createApp({ db, client, corsOrigin: '*' });

  const mathsHex = state.lessonMathsId.toHexString();
  const englishHex = state.lessonEnglishId.toHexString();

  // Bad ID & missing order
  assert.equal((await sendAppRequest(app, 'DELETE', '/orders/not-valid')).status, 400);
  assert.equal((await sendAppRequest(app, 'DELETE', `/orders/${new ObjectId().toHexString()}`)).status, 404);

  // 1) Full unconfirmed pending order cancellation
  const fullOrderRes = await sendAppRequest(app, 'POST', '/orders', {
    jsonBody: { name: 'Jordan Lee', phone: '07000000001', items: [{ lessonId: mathsHex, space: 2 }] }
  });
  const fullOrderId = String(fullOrderRes.json.order._id);

  const cancelFull = await sendAppRequest(app, 'DELETE', `/orders/${fullOrderId}`);
  assert.equal(cancelFull.status, 200);
  assert.equal(cancelFull.json.status, 'cancelled');
  assert.equal(store.collections.lesson[0].space, 5);
  assert.equal(store.collections.order[0].status, 'cancelled');
  assert.equal(store.collections.order[0].items[0].cancelled, true);

  // Repeat cancellation rejected cleanly
  const dupCancelFull = await sendAppRequest(app, 'DELETE', `/orders/${fullOrderId}`);
  assert.equal(dupCancelFull.status, 400);
  assert.equal(dupCancelFull.json.error, 'Already cancelled');

  // 2) Partial order: confirm Maths (space 5 -> 3), leave English unconfirmed, then DELETE
  const partialRes = await sendAppRequest(app, 'POST', '/orders', {
    jsonBody: {
      name: 'Sam Patel',
      phone: '07000000002',
      items: [
        { lessonId: mathsHex, space: 2 },
        { lessonId: englishHex, space: 1 }
      ]
    }
  });
  const partialOrderId = String(partialRes.json.order._id);

  const confirmMaths = await sendAppRequest(app, 'PUT', `/lessons/${mathsHex}`, {
    jsonBody: { space: 3, orderId: partialOrderId }
  });
  assert.equal(confirmMaths.status, 200);

  const cancelPartial = await sendAppRequest(app, 'DELETE', `/orders/${partialOrderId}`);
  assert.equal(cancelPartial.status, 200);
  assert.equal(cancelPartial.json.status, 'partially_cancelled');
  assert.equal(store.collections.lesson[0].space, 3);
  assert.equal(store.collections.lesson[1].space, 4);
  assert.equal(store.collections.order[1].items[0].confirmed, true);
  assert.equal(store.collections.order[1].items[1].cancelled, true);

  // Confirmed enrolment count reflects Maths=2 and English=0
  const mathsEnrol = await sendAppRequest(app, 'GET', `/enrolment/${mathsHex}`);
  assert.equal(mathsEnrol.json.totalEnrolled, 2);

  // Repeat DELETE on partially_cancelled order rejects cleanly as 'Nothing to cancel'
  const dupPartial = await sendAppRequest(app, 'DELETE', `/orders/${partialOrderId}`);
  assert.equal(dupPartial.status, 400);
  assert.equal(dupPartial.json.error, 'Nothing to cancel');

  // 3) Confirmed order cannot be cancelled
  const confirmedOrderId = new ObjectId();
  store.collections.order.push({
    _id: confirmedOrderId,
    name: 'Chris Ng',
    phone: '07000000003',
    status: 'confirmed',
    items: [{ lessonId: state.lessonEnglishId, space: 1, confirmed: true }]
  });
  const cancelConfirmed = await sendAppRequest(app, 'DELETE', `/orders/${confirmedOrderId.toHexString()}`);
  assert.equal(cancelConfirmed.status, 400);
  assert.equal(cancelConfirmed.json.error, 'Cannot cancel');

  // 4) Concurrent status change returns 409 conflict & tx crash rolls back cleanly
  const pendingRes = await sendAppRequest(app, 'POST', '/orders', {
    jsonBody: { name: 'Nina Roy', phone: '07000000004', items: [{ lessonId: englishHex, space: 1 }] }
  });
  const pendingOrderId = String(pendingRes.json.order._id);

  forceConcurrentStatusChange = true;
  try {
    const conflictCancel = await sendAppRequest(app, 'DELETE', `/orders/${pendingOrderId}`);
    assert.equal(conflictCancel.status, 409);
    assert.equal(conflictCancel.json.error, 'Conflict');
  } finally {
    forceConcurrentStatusChange = false;
  }

  const origConsoleError = console.error;
  console.error = () => {};
  forceTxCrash = true;
  try {
    const prevRollbacks = stats.rollbacks;
    const crashedCancel = await sendAppRequest(app, 'DELETE', `/orders/${pendingOrderId}`);
    assert.equal(crashedCancel.status, 500);
    assert.equal(stats.rollbacks, prevRollbacks + 1);
    const saved = store.collections.order.find((o) => String(o._id) === pendingOrderId);
    assert.equal(saved.status, 'pending');
    assert.equal(saved.items[0].cancelled, undefined);
  } finally {
    forceTxCrash = false;
    console.error = origConsoleError;
  }
});
