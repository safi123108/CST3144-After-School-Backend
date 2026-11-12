const express = require('express');
const cors = require('cors');
const path = require('path');
const { ObjectId } = require('mongodb');
const { createImageMiddleware } = require('./middleware/images');
const { fetchAllLessons, searchLessons } = require('./services/lessons');

const DEFAULT_DB_NAME = 'after_school_app';
const DEFAULT_IMAGES_DIR = path.join(__dirname, 'public', 'images');

function resolveAccessor(accessorFn, fallbackValue) {
  return typeof accessorFn === 'function' ? accessorFn : () => (fallbackValue ?? null);
}

function requireSessionClient(getClient, res) {
  const client = getClient();
  if (!client || typeof client.startSession !== 'function') {
    res.status(503).json({
      success: false,
      error: 'Service unavailable',
      message: 'Database client session is unavailable.'
    });
    return null;
  }
  return client;
}

function handleTransactionError(res, err, fallbackMessage, defaultConflictMessage) {
  if (err && err.statusCode === 409) {
    return res.status(409).json({
      success: false,
      error: 'Conflict',
      message: err.message || defaultConflictMessage
    });
  }

  if (err && err.statusCode === 404) {
    return res.status(404).json({
      success: false,
      error: 'Not found',
      message: err.message
    });
  }

  if (err && err.statusCode === 400) {
    return res.status(400).json({
      success: false,
      error: err.errorCode || 'Bad request',
      message: err.message
    });
  }

  console.error('Transaction error:', err && err.message ? err.message : err);
  return res.status(500).json({
    success: false,
    message: fallbackMessage
  });
}

/**
 * Create and configure the Express application with injected database accessors.
 * Keeping app construction separate from server startup enables isolated testing.
 */
function createApp(options = {}) {
  const getDb = resolveAccessor(options.getDb, options.db);
  const getClient = resolveAccessor(options.getClient, options.client);
  const dbName = options.dbName || DEFAULT_DB_NAME;
  const imagesDir = options.imagesDir || DEFAULT_IMAGES_DIR;

  const app = express();

  // Enable Cross-Origin Resource Sharing (CORS)
  app.use(cors());

  // Request logger middleware: logs HTTP method and requested URL
  app.use((req, res, next) => {
    console.log(`[${req.method}] ${req.url}`);
    next();
  });

  // Parse incoming JSON request bodies
  app.use(express.json());

  // Static image serving, seeded .png -> .svg fallback, and clean 404 JSON handling
  app.use('/images', createImageMiddleware({ imagesDir }));

  // Guard database-backed API endpoints when MongoDB is not connected
  const requireDb = (req, res, next) => {
    if (!getDb()) {
      return res.status(503).json({
        success: false,
        error: 'Service unavailable',
        message: 'Database connection is not ready.'
      });
    }
    return next();
  };

  app.use(['/lessons', '/orders', '/teachers', '/enrolment'], requireDb);

  // Root endpoint
  app.get('/', (req, res) => {
    res.send('After-School App Backend is running!');
  });

  // Health check endpoint (reports backend and database status)
  app.get('/api/health', (req, res) => {
    const isDbConnected = getDb() !== null;
    res.json({
      success: true,
      message: 'Backend is working correctly',
      database: {
        connected: isDbConnected,
        name: isDbConnected ? dbName : null
      }
    });
  });

  // GET /lessons - retrieve all lesson documents from the "lesson" collection
  app.get('/lessons', async (req, res) => {
    const db = getDb();
    try {
      const lessons = await fetchAllLessons(db);
      res.json(lessons);
    } catch (error) {
      console.error('Error retrieving lessons:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve lessons from database'
      });
    }
  });

  // GET /lessons/search - multi-attribute case-insensitive search across lessons
  app.get('/lessons/search', async (req, res) => {
    const db = getDb();
    const rawQ = req.query.q;

    // 1. Reject repeated q parameters (arrays) or non-string types when provided
    if (rawQ !== undefined && typeof rawQ !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Invalid query parameter',
        message: "The 'q' query parameter must be a single string."
      });
    }

    const query = rawQ === undefined ? '' : rawQ.trim();

    // 2. Reject search queries longer than 100 characters
    if (query.length > 100) {
      return res.status(400).json({
        success: false,
        error: 'Query too long',
        message: "Search query 'q' must not exceed 100 characters."
      });
    }

    // 3. Return all lessons for missing/blank queries, or execute multi-attribute filter search
    try {
      const results = await searchLessons(db, query);
      return res.json(results);
    } catch (error) {
      console.error('Error performing lesson search:', error.message);
      return res.status(500).json({
        success: false,
        message: query ? 'Failed to perform search in database' : 'Failed to retrieve lessons from database'
      });
    }
  });

  // PUT /lessons/:id - update any permitted attribute of a lesson document
  app.put('/lessons/:id', async (req, res) => {
    const db = getDb();
    const { id } = req.params;

    // 1. Validate ObjectId format
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ID',
        message: `The provided lesson ID '${id}' is not a valid 24-character hexadecimal MongoDB ObjectId.`
      });
    }

    const lessonObjectId = new ObjectId(id);
    const updates = req.body;

    // 2. Reject empty or non-object request bodies
    if (!updates || typeof updates !== 'object' || Array.isArray(updates) || Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Empty update payload',
        message: 'Request body must be a non-empty JSON object with at least one attribute to update.'
      });
    }

    // 3. Strictly reject attempts to modify _id
    if ('_id' in updates) {
      return res.status(400).json({
        success: false,
        error: 'Immutable field',
        message: 'Modification of the primary key (_id) is strictly prohibited.'
      });
    }

    // Permitted attributes whitelist
    const allowedFields = ['topic', 'location', 'price', 'space', 'image', 'teacherId', 'orderId'];
    const updateData = {};

    // 4. Validate each field and its data type
    for (const [key, value] of Object.entries(updates)) {
      if (!allowedFields.includes(key)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid attribute',
          message: `Field '${key}' is not a recognized or permitted lesson attribute.`
        });
      }

      if (key === 'topic' || key === 'location') {
        if (typeof value !== 'string' || value.trim().length === 0) {
          return res.status(400).json({
            success: false,
            error: 'Invalid data type',
            message: `'${key}' must be a non-empty string.`
          });
        }
        updateData[key] = value.trim();
      } else if (key === 'price') {
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
          return res.status(400).json({
            success: false,
            error: 'Invalid data type',
            message: `'price' must be a positive, finite number greater than 0.`
          });
        }
        updateData[key] = value;
      } else if (key === 'space') {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
          return res.status(400).json({
            success: false,
            error: 'Invalid data type',
            message: `'space' must be a non-negative integer (0 or greater).`
          });
        }
        updateData[key] = value;
      } else if (key === 'image') {
        if (
          typeof value !== 'string' ||
          value.trim().length === 0 ||
          /[/\\]|\.\./.test(value)
        ) {
          return res.status(400).json({
            success: false,
            error: 'Invalid data type',
            message: `'image' must be a simple filename (e.g., 'maths.png') without path traversal or directory separators.`
          });
        }
        updateData[key] = value.trim();
      } else if (key === 'teacherId') {
        if (!ObjectId.isValid(value)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid data type',
            message: `'teacherId' must be a valid 24-character hexadecimal MongoDB ObjectId.`
          });
        }
        updateData[key] = new ObjectId(value);
      } else if (key === 'orderId') {
        if (!ObjectId.isValid(value)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid data type',
            message: `'orderId' must be a valid 24-character hexadecimal MongoDB ObjectId.`
          });
        }
        updateData[key] = value;
      }
    }

    try {
      // If orderId is present, this is an order confirmation PUT
      if ('orderId' in updateData) {
        const { orderId } = updateData;

        if (!('space' in updateData)) {
          return res.status(400).json({
            success: false,
            error: 'Missing space',
            message: "Order confirmation updates require a non-negative integer 'space' value."
          });
        }

        const extraFields = Object.keys(updateData).filter(
          (field) => field !== 'orderId' && field !== 'space'
        );
        if (extraFields.length > 0) {
          return res.status(400).json({
            success: false,
            error: 'Conflicting attributes',
            message: `Order confirmation updates only permit 'orderId' and 'space'; unexpected field(s): ${extraFields.join(', ')}.`
          });
        }

        res.on('finish', () => {
          console.log(`[PUT /lessons/:id] confirmation status=${res.statusCode} lessonId=${id} orderId=${String(orderId)}`);
        });

        const client = requireSessionClient(getClient, res);
        if (!client) return;

        const orderObjectId = new ObjectId(orderId);
        const session = client.startSession();
        try {
          await session.withTransaction(async () => {
            // Find the pending order
            const order = await db.collection('order').findOne(
              { _id: orderObjectId, status: 'pending' },
              { session }
            );

            if (!order) {
              const error = new Error('ORDER_NOT_FOUND_OR_NOT_PENDING');
              error.statusCode = 404;
              throw error;
            }

            // Find the matching item for this lesson
            const orderItems = Array.isArray(order.items) ? order.items : [];
            const itemIndex = orderItems.findIndex(
              item => item && item.lessonId && item.lessonId.equals(lessonObjectId)
            );

            if (itemIndex === -1) {
              const error = new Error('ITEM_NOT_FOUND_IN_ORDER');
              error.statusCode = 404;
              throw error;
            }

            const item = orderItems[itemIndex];

            // Cancelled items cannot be confirmed
            if (item.cancelled === true) {
              const error = new Error('ITEM_CANCELLED');
              error.statusCode = 400;
              error.message = `Lesson '${id}' item is cancelled and cannot be confirmed.`;
              throw error;
            }

            // Idempotent: already confirmed
            if (item.confirmed === true) {
              return;
            }

            if (typeof item.space !== 'number' || !Number.isInteger(item.space) || item.space <= 0) {
              const error = new Error('INVALID_ORDER_ITEM_SPACE');
              error.statusCode = 400;
              error.message = `Order '${orderId}' item for lesson '${id}' has an invalid space quantity.`;
              throw error;
            }

            // Read current lesson space for compare-and-set
            const existingLesson = await db.collection('lesson').findOne(
              { _id: lessonObjectId },
              { session }
            );

            if (!existingLesson) {
              const error = new Error('LESSON_NOT_FOUND');
              error.statusCode = 404;
              throw error;
            }

            const expectedCurrentSpace = updateData.space + item.space;

            // Compare-and-set: only update if space hasn't changed since frontend read it
            const result = await db.collection('lesson').updateOne(
              { _id: lessonObjectId, space: expectedCurrentSpace },
              { $set: { space: updateData.space } },
              { session }
            );

            if (result.matchedCount === 0) {
              const error = new Error('SPACE_CONFLICT');
              error.statusCode = 409;
              error.message = `Lesson '${existingLesson.topic || id}' space was changed by another operation.`;
              throw error;
            }

            // Mark item confirmed
            await db.collection('order').updateOne(
              { _id: orderObjectId, 'items.lessonId': lessonObjectId },
              { $set: { 'items.$.confirmed': true } },
              { session }
            );

            // Check if all items are confirmed -> mark order confirmed
            const updatedOrder = await db.collection('order').findOne(
              { _id: orderObjectId },
              { session }
            );

            const nextItems = updatedOrder && Array.isArray(updatedOrder.items) ? updatedOrder.items : [];
            const allConfirmed = nextItems.length > 0 && nextItems.every(
              orderItem => orderItem && (orderItem.confirmed === true || orderItem.cancelled === true)
            );

            if (allConfirmed) {
              await db.collection('order').updateOne(
                { _id: orderObjectId },
                { $set: { status: 'confirmed', confirmedAt: new Date() } },
                { session }
              );
            }
          });

          return res.json({
            success: true,
            message: 'Lesson space updated and order item confirmed',
            lessonId: id,
            orderId: orderId
          });
        } catch (transactionError) {
          return handleTransactionError(
            res,
            transactionError,
            'Failed to update lesson space and order item',
            'Lesson space was changed by another operation.'
          );
        } finally {
          await session.endSession();
        }
      }

      // Non-order updates: existing behaviour
      // Case A: teacherId is not being updated
      if (!('teacherId' in updateData)) {
        const queryFilter = { _id: new ObjectId(id) };

        // Optimistic concurrency: only apply space update if space hasn't changed
        if ('space' in updateData) {
          const currentLesson = await db.collection('lesson').findOne({
            _id: new ObjectId(id)
          });
          if (!currentLesson) {
            return res.status(404).json({
              success: false,
              error: 'Not found',
              message: `Lesson with ID '${id}' was not found in the database.`
            });
          }
          queryFilter.space = currentLesson.space;
        }

        const result = await db.collection('lesson').updateOne(
          queryFilter,
          { $set: updateData }
        );

        if (result.matchedCount === 0) {
          if ('space' in updateData) {
            return res.status(409).json({
              success: false,
              error: 'Conflict',
              message: `Lesson '${id}' space was changed by another operation. Please refresh and try again.`
            });
          }
          return res.status(404).json({
            success: false,
            error: 'Not found',
            message: `Lesson with ID '${id}' was not found in the database.`
          });
        }

        return res.json({
          success: true,
          message: 'Lesson updated successfully',
          modifiedCount: result.modifiedCount
        });
      }

      // Case B: teacherId is being updated — synchronize teacher relationships in one transaction.
      const client = requireSessionClient(getClient, res);
      if (!client) return;

      const session = client.startSession();
      try {
        let modifiedCount = 0;

        await session.withTransaction(async () => {
          // Fetch the existing lesson to find the previous teacher.
          const existingLesson = await db.collection('lesson').findOne(
            { _id: new ObjectId(id) },
            { session }
          );

          if (!existingLesson) {
            const error = new Error('LESSON_NOT_FOUND');
            error.statusCode = 404;
            throw error;
          }

          const oldTeacherId = existingLesson.teacherId;
          const newTeacherId = updateData.teacherId; // already an ObjectId from validation

          // Validate that the new teacher exists before comparing with the old teacher.
          const newTeacher = await db.collection('teacher').findOne(
            { _id: newTeacherId },
            { session }
          );

          if (!newTeacher) {
            const error = new Error('TEACHER_NOT_FOUND');
            error.statusCode = 404;
            throw error;
          }

          // If the teacher is unchanged, only update the lesson fields.
          if (oldTeacherId && oldTeacherId.equals(newTeacherId)) {
            const lessonFilter = { _id: new ObjectId(id) };
            if ('space' in updateData) {
              lessonFilter.space = existingLesson.space;
            }
            const result = await db.collection('lesson').updateOne(
              lessonFilter,
              { $set: updateData },
              { session }
            );
            if (result.matchedCount === 0 && 'space' in updateData) {
              const error = new Error('SPACE_CONFLICT');
              error.statusCode = 409;
              error.message = `Lesson '${existingLesson.topic || id}' space was changed by another operation.`;
              throw error;
            }
            modifiedCount = result.modifiedCount;
            return;
          }

          // Remove the lesson from the old teacher's lessonIds (if there was an old teacher).
          if (oldTeacherId) {
            await db.collection('teacher').updateOne(
              { _id: oldTeacherId },
              { $pull: { lessonIds: new ObjectId(id) } },
              { session }
            );
          }

          // Add the lesson to the new teacher's lessonIds.
          await db.collection('teacher').updateOne(
            { _id: newTeacherId },
            { $addToSet: { lessonIds: new ObjectId(id) } },
            { session }
          );

          // Update the lesson (teacherId plus any other fields being changed).
          const lessonFilter = { _id: new ObjectId(id) };
          if ('space' in updateData) {
            lessonFilter.space = existingLesson.space;
          }
          const result = await db.collection('lesson').updateOne(
            lessonFilter,
            { $set: updateData },
            { session }
          );
          if (result.matchedCount === 0 && 'space' in updateData) {
            const error = new Error('SPACE_CONFLICT');
            error.statusCode = 409;
            error.message = `Lesson '${existingLesson.topic || id}' space was changed by another operation.`;
            throw error;
          }
          modifiedCount = result.modifiedCount;
        });

        // Transaction committed successfully.
        return res.json({
          success: true,
          message: 'Lesson updated successfully',
          modifiedCount: modifiedCount
        });
      } catch (transactionError) {
        // Map known 404 conditions.
        if (transactionError.statusCode === 404) {
          const message = transactionError.message === 'LESSON_NOT_FOUND'
            ? `Lesson with ID '${id}' was not found in the database.`
            : `Teacher with ID '${updateData.teacherId}' was not found in the database.`;
          return res.status(404).json({
            success: false,
            error: 'Not found',
            message: message
          });
        }

        // Optimistic concurrency conflict on space update
        if (transactionError.statusCode === 409) {
          return res.status(409).json({
            success: false,
            error: 'Conflict',
            message: transactionError.message || 'Lesson space was changed by another operation.'
          });
        }

        console.error('Transaction error:', transactionError.message);
        return res.status(500).json({
          success: false,
          message: 'Failed to update lesson and teacher relationships in database'
        });
      } finally {
        await session.endSession();
      }
    } catch (error) {
      console.error('Error updating lesson:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to update lesson in database'
      });
    }
  });

  // POST /orders - create a new order with space availability checks and atomic updates
  app.post('/orders', async (req, res) => {
    const db = getDb();
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { name, phone, items } = body;

    // 1. Validate customer name: must be a non-empty string containing only letters and spaces
    if (typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid name',
        message: "Customer 'name' is required and must be a non-empty string."
      });
    }
    if (!/^[a-zA-Z\s]+$/.test(name.trim())) {
      return res.status(400).json({
        success: false,
        error: 'Invalid name',
        message: "Customer 'name' must contain only letters and spaces."
      });
    }

    // 2. Validate phone number: must be a non-empty string containing only digits
    if (typeof phone !== 'string' || phone.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid phone',
        message: "Customer 'phone' is required and must be a non-empty string."
      });
    }
    if (!/^\d+$/.test(phone.trim())) {
      return res.status(400).json({
        success: false,
        error: 'Invalid phone',
        message: "Customer 'phone' must contain only digits."
      });
    }

    // 3. Validate items: must be a non-empty array
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid items',
        message: "'items' must be a non-empty array of order items."
      });
    }

    // 4. Validate each item: lessonId (valid ObjectId) and space (positive integer)
    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      if (!item || typeof item !== 'object') {
        return res.status(400).json({
          success: false,
          error: 'Invalid item',
          message: `Item at index ${i} must be an object with 'lessonId' and 'space' properties.`
        });
      }

      if (!item.lessonId || !ObjectId.isValid(item.lessonId)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid lessonId',
          message: `Item at index ${i}: 'lessonId' must be a valid 24-character hexadecimal MongoDB ObjectId.`
        });
      }

      if (typeof item.space !== 'number' || !Number.isInteger(item.space) || item.space <= 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid space',
          message: `Item at index ${i}: 'space' must be a positive integer (1 or greater).`
        });
      }
    }

    // 5. Consolidate duplicate lessonIds by summing their spaces
    const consolidated = {};
    for (const item of items) {
      const lessonIdStr = item.lessonId.toString();
      if (consolidated[lessonIdStr]) {
        consolidated[lessonIdStr] += item.space;
      } else {
        consolidated[lessonIdStr] = item.space;
      }
    }

    // Build consolidated items array with ObjectId keys
    const consolidatedItems = Object.entries(consolidated).map(([lessonIdStr, space]) => ({
      lessonId: new ObjectId(lessonIdStr),
      space: space
    }));

    try {
      // 6. Check that every requested lesson exists
      const lessonIds = consolidatedItems.map(item => item.lessonId);
      const lessons = await db.collection('lesson').find({
        _id: { $in: lessonIds }
      }).toArray();

      if (lessons.length !== lessonIds.length) {
        const foundIds = lessons.map(l => l._id.toString());
        const missingIds = lessonIds
          .map(id => id.toString())
          .filter(id => !foundIds.includes(id));
        return res.status(404).json({
          success: false,
          error: 'Lesson not found',
          message: `The following lesson IDs were not found: ${missingIds.join(', ')}`
        });
      }

      // 7. Check sufficient available spaces for every lesson
      for (const item of consolidatedItems) {
        const lesson = lessons.find(l => l._id.equals(item.lessonId));
        if (lesson.space < item.space) {
          return res.status(409).json({
            success: false,
            error: 'Insufficient spaces',
            message: `Lesson '${lesson.topic || lesson._id}' has only ${lesson.space} space(s) available, but ${item.space} were requested.`
          });
        }
      }

      // 8. Insert the pending order. Space is NOT decremented here;
      // the frontend updates lesson spaces via PUT /lessons/:id after checkout.
      const orderDocument = {
        name: name.trim(),
        phone: phone.trim(),
        items: consolidatedItems.map(item => ({
          lessonId: item.lessonId,
          space: item.space,
          confirmed: false
        })),
        status: 'pending',
        createdAt: new Date()
      };

      try {
        const insertResult = await db.collection('order').insertOne(orderDocument);
        res.status(201).json({
          success: true,
          message: 'Order placed successfully',
          order: {
            _id: insertResult.insertedId,
            name: orderDocument.name,
            phone: orderDocument.phone,
            items: orderDocument.items,
            status: orderDocument.status,
            createdAt: orderDocument.createdAt
          }
        });
      } catch (insertError) {
        console.error('Insert order error:', insertError.message);
        res.status(500).json({
          success: false,
          message: 'Failed to create order in database'
        });
      }
    } catch (error) {
      console.error('Error creating order:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to create order in database'
      });
    }
  });

  // GET /teachers - retrieve all teacher documents from the "teacher" collection
  app.get('/teachers', async (req, res) => {
    const db = getDb();
    try {
      const teachers = await db.collection('teacher').find({}).toArray();
      res.json(teachers);
    } catch (error) {
      console.error('Error retrieving teachers:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve teachers from database'
      });
    }
  });

  // GET /teachers/:id/lessons - retrieve all lessons taught by a specific teacher
  app.get('/teachers/:id/lessons', async (req, res) => {
    const db = getDb();
    const { id } = req.params;

    // 1. Validate teacher ID format
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ID',
        message: `The provided teacher ID '${id}' is not a valid 24-character hexadecimal MongoDB ObjectId.`
      });
    }

    try {
      // 2. Find the teacher in the "teacher" collection
      const teacher = await db.collection('teacher').findOne({ _id: new ObjectId(id) });

      if (!teacher) {
        return res.status(404).json({
          success: false,
          error: 'Not found',
          message: `Teacher with ID '${id}' was not found in the database.`
        });
      }

      // 3. Check if teacher has associated lessonIds
      if (!Array.isArray(teacher.lessonIds) || teacher.lessonIds.length === 0) {
        return res.json([]);
      }

      // 4. Retrieve matching lessons from the "lesson" collection
      const lessons = await db.collection('lesson').find({
        _id: { $in: teacher.lessonIds }
      }).toArray();

      res.json(lessons);
    } catch (error) {
      console.error('Error retrieving lessons for teacher:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve teacher lessons from database'
      });
    }
  });

  // GET /enrolment/:lessonid - calculate total spaces purchased for a specific lesson
  app.get('/enrolment/:lessonid', async (req, res) => {
    const db = getDb();
    const { lessonid } = req.params;

    // 1. Validate lesson ID format
    if (!ObjectId.isValid(lessonid)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ID',
        message: `The provided lesson ID '${lessonid}' is not a valid 24-character hexadecimal MongoDB ObjectId.`
      });
    }

    try {
      const lessonObjectId = new ObjectId(lessonid);

      // 2. Check whether the lesson exists in the "lesson" collection
      const lesson = await db.collection('lesson').findOne({ _id: lessonObjectId });
      if (!lesson) {
        return res.status(404).json({
          success: false,
          error: 'Not found',
          message: `Lesson with ID '${lessonid}' was not found in the database.`
        });
      }

      // 3. Find all orders containing this lesson in their items array
      const orders = await db.collection('order').find({
        'items.lessonId': lessonObjectId
      }).toArray();

      // 4. Sum the purchased spaces across matching order items
      let totalEnrolled = 0;
      for (const order of orders) {
        if (Array.isArray(order.items)) {
          for (const item of order.items) {
            if (item && item.lessonId && typeof item.lessonId.equals === 'function' && item.lessonId.equals(lessonObjectId)) {
              if (typeof item.space === 'number' && Number.isInteger(item.space) && item.space > 0) {
                // Count confirmed items only; legacy orders (no confirmed field) count as confirmed
                if (item.confirmed === true || item.confirmed === undefined) {
                  totalEnrolled += item.space;
                }
              }
            }
          }
        }
      }

      res.json({
        success: true,
        lessonId: lessonid,
        totalEnrolled: totalEnrolled
      });
    } catch (error) {
      console.error('Error calculating lesson enrolment:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to calculate lesson enrolment from database'
      });
    }
  });

  // DELETE /orders/:orderId - cancel unconfirmed items in a pending order atomically
  app.delete('/orders/:orderId', async (req, res) => {
    const db = getDb();
    const { orderId } = req.params;

    if (!ObjectId.isValid(orderId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ID',
        message: `The provided order ID '${orderId}' is not a valid 24-character hexadecimal MongoDB ObjectId.`
      });
    }

    const client = requireSessionClient(getClient, res);
    if (!client) return;

    const orderObjectId = new ObjectId(orderId);
    const session = client.startSession();
    try {
      let finalStatus = null;

      await session.withTransaction(async () => {
        const order = await db.collection('order').findOne(
          { _id: orderObjectId },
          { session }
        );

        if (!order) {
          const error = new Error('ORDER_NOT_FOUND');
          error.statusCode = 404;
          error.message = `Order with ID '${orderId}' was not found.`;
          throw error;
        }

        if (order.status === 'confirmed') {
          const error = new Error('ORDER_ALREADY_CONFIRMED');
          error.statusCode = 400;
          error.errorCode = 'Cannot cancel';
          error.message = `Order '${orderId}' is already confirmed and cannot be cancelled.`;
          throw error;
        }

        if (order.status === 'cancelled') {
          const error = new Error('ORDER_ALREADY_CANCELLED');
          error.statusCode = 400;
          error.errorCode = 'Already cancelled';
          error.message = `Order '${orderId}' is already cancelled.`;
          throw error;
        }

        const items = Array.isArray(order.items) ? order.items : [];
        let anyConfirmed = false;
        let anyCancellable = false;

        const updatedItems = items.map((item) => {
          if (item && item.confirmed === true) {
            anyConfirmed = true;
            return item;
          }
          if (item && item.cancelled === true) {
            return item;
          }
          anyCancellable = true;
          return { ...item, cancelled: true };
        });

        if (!anyCancellable) {
          const error = new Error('NOTHING_TO_CANCEL');
          error.statusCode = 400;
          error.errorCode = 'Nothing to cancel';
          error.message = `Order '${orderId}' has no unconfirmed active items to cancel.`;
          throw error;
        }

        // Preserve confirmed items on partial orders without altering lesson.space,
        // because POST /orders does not decrement spaces before PUT /lessons/:id confirmation.
        finalStatus = anyConfirmed ? 'partially_cancelled' : 'cancelled';

        const updateFilter = order.status !== undefined
          ? { _id: orderObjectId, status: order.status }
          : { _id: orderObjectId };

        const updateResult = await db.collection('order').updateOne(
          updateFilter,
          { $set: { items: updatedItems, status: finalStatus, cancelledAt: new Date() } },
          { session }
        );

        if (updateResult.matchedCount === 0) {
          const error = new Error('ORDER_STATE_CONFLICT');
          error.statusCode = 409;
          error.message = `Order '${orderId}' was changed by another operation. Please retry.`;
          throw error;
        }
      });

      return res.json({
        success: true,
        message: `Order '${orderId}' cancellation processed`,
        orderId: orderId,
        status: finalStatus
      });
    } catch (error) {
      return handleTransactionError(
        res,
        error,
        'Failed to cancel order',
        'Order was changed by another operation.'
      );
    } finally {
      await session.endSession();
    }
  });

  // Generic JSON 404 fallback for unmatched routes
  app.use((req, res) => {
    res.status(404).json({
      success: false,
      error: 'Not found',
      message: `Route '${req.method} ${req.originalUrl}' was not found.`
    });
  });

  // Centralized JSON error handler (including malformed JSON body parsing errors)
  app.use((err, req, res, next) => {
    if (res.headersSent) {
      return next(err);
    }

    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
      return res.status(400).json({
        success: false,
        error: 'Invalid JSON',
        message: 'Request body contains malformed JSON.'
      });
    }

    const statusCode =
      Number.isInteger(err && err.statusCode) && err.statusCode >= 400 && err.statusCode < 600
        ? err.statusCode
        : Number.isInteger(err && err.status) && err.status >= 400 && err.status < 600
          ? err.status
          : 500;

    if (statusCode >= 500) {
      console.error('Unhandled request error:', err && err.message ? err.message : err);
    }

    return res.status(statusCode).json({
      success: false,
      error: statusCode >= 500 ? 'Internal server error' : 'Request error',
      message: statusCode >= 500 ? 'An unexpected server error occurred.' : (err && err.message) || 'Invalid request.'
    });
  });

  return app;
}

module.exports = {
  createApp,
  DEFAULT_DB_NAME
};
