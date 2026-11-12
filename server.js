const path = require('path');
const { MongoClient } = require('mongodb');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { createApp, DEFAULT_DB_NAME } = require('./app');

let db = null;
let client = null;
let httpServer = null;
let shutdownPromise = null;
let shutdownHandlersRegistered = false;

function listenAsync(app, port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
    server.once('error', reject);
  });
}

function closeServerAsync(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) return reject(err);
      return resolve();
    });
  });
}

/**
 * Connect to MongoDB Atlas using the native driver and start the Express HTTP server.
 */
async function startServer(options = {}) {
  const port =
    options.port !== undefined && options.port !== null
      ? options.port
      : (process.env.PORT || 3000);
  const mongoUri = options.mongoUri ?? process.env.MONGODB_URI;
  const dbName = options.dbName ?? process.env.DB_NAME ?? DEFAULT_DB_NAME;
  const corsOrigin = 'corsOrigin' in options ? options.corsOrigin : process.env.CORS_ORIGIN;
  const createClient =
    typeof options.createClient === 'function'
      ? options.createClient
      : (uri) => new MongoClient(uri);

  if (!mongoUri) {
    throw new Error('MONGODB_URI is not defined in environment variables.');
  }

  console.log('Connecting to MongoDB Atlas...');
  const mongoClient = createClient(mongoUri);
  try {
    await mongoClient.connect();
    client = mongoClient;
    db = mongoClient.db(dbName);
    console.log(`Successfully connected to MongoDB Atlas database: "${dbName}"`);

    const app = createApp({
      getDb: () => db,
      getClient: () => client,
      dbName,
      corsOrigin
    });

    httpServer = await listenAsync(app, port);
    const boundAddress = httpServer.address();
    const activePort = boundAddress && typeof boundAddress === 'object' ? boundAddress.port : port;
    console.log(`Server is running on port ${activePort}`);

    return { app, server: httpServer, client, db };
  } catch (error) {
    db = null;
    client = null;
    httpServer = null;
    if (mongoClient && typeof mongoClient.close === 'function') {
      await mongoClient.close().catch(() => {});
    }
    throw error;
  }
}

/**
 * Gracefully close the HTTP server and MongoDB client connection.
 * Idempotent: concurrent or repeated calls await the same shutdown sequence.
 */
async function stopServer() {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    const activeServer = httpServer;
    const activeClient = client;

    httpServer = null;

    try {
      await closeServerAsync(activeServer);
    } finally {
      db = null;
      client = null;
      try {
        if (activeClient && typeof activeClient.close === 'function') {
          await activeClient.close();
        }
      } finally {
        shutdownPromise = null;
      }
    }
  })();

  return shutdownPromise;
}

/**
 * Register SIGTERM and SIGINT listeners once to avoid duplicate shutdown handlers.
 */
function registerShutdownHandlers(options = {}) {
  if (shutdownHandlersRegistered) {
    return false;
  }
  shutdownHandlersRegistered = true;

  const targetProcess = options.targetProcess || process;
  const onExit = typeof options.onExit === 'function' ? options.onExit : (code) => targetProcess.exit(code);

  const handleSignal = async (signal) => {
    console.log(`Received ${signal}. Shutting down gracefully...`);
    const forceExitTimer = setTimeout(() => {
      console.error('Graceful shutdown timed out; forcing exit.');
      onExit(1);
    }, 10000);
    if (typeof forceExitTimer.unref === 'function') {
      forceExitTimer.unref();
    }

    try {
      await stopServer();
      clearTimeout(forceExitTimer);
      onExit(0);
    } catch (error) {
      clearTimeout(forceExitTimer);
      console.error('Error during graceful shutdown:', error.message);
      onExit(1);
    }
  };

  targetProcess.once('SIGTERM', () => handleSignal('SIGTERM'));
  targetProcess.once('SIGINT', () => handleSignal('SIGINT'));
  return true;
}

if (require.main === module) {
  registerShutdownHandlers();
  startServer().catch((error) => {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  });
}

module.exports = {
  createApp,
  startServer,
  stopServer,
  registerShutdownHandlers
};
