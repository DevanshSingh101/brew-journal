// MongoDB connection and collections.
// Production: set MONGODB_URI (e.g. a MongoDB Atlas cluster).
// Development without MONGODB_URI: an embedded mongod from mongodb-memory-server,
// persisted to ./.mongo-data, so the app runs with zero setup.

const fs = require('node:fs');
const path = require('node:path');
const { MongoClient, ObjectId } = require('mongodb');

let client;
let database;
let embedded;

async function startEmbedded() {
  let MongoMemoryServer;
  try {
    ({ MongoMemoryServer } = require('mongodb-memory-server'));
  } catch {
    throw new Error('MONGODB_URI is not set and the local development database is not installed (run `npm install`).');
  }
  const dbPath = process.env.MONGO_DATA_DIR || path.join(__dirname, '..', '.mongo-data');
  fs.mkdirSync(dbPath, { recursive: true });
  embedded = await MongoMemoryServer.create({ instance: { dbPath, storageEngine: 'wiredTiger' } });
  return embedded.getUri();
}

async function connect() {
  let uri = process.env.MONGODB_URI;
  if (!uri) {
    if (process.env.NODE_ENV === 'production') throw new Error('MONGODB_URI must be set in production.');
    uri = await startEmbedded();
  }
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  database = client.db(process.env.MONGODB_DB || 'brew-journal');

  await Promise.all([
    users().createIndex({ email: 1 }, { unique: true }),
    items().createIndex({ user_id: 1, created_at: -1 }),
    // A per-user unique nonce makes brew submission idempotent (double clicks, refreshes).
    brews().createIndex({ user_id: 1, nonce: 1 }, { unique: true }),
    brews().createIndex({ item_id: 1, created_at: -1 }),
    brews().createIndex({ user_id: 1, created_at: -1 }),
  ]);
  return { embedded: Boolean(embedded) };
}

async function close() {
  await client?.close();
  await embedded?.stop();
}

const users = () => database.collection('users');
// A coffee bean or a tea. `variety` is the roast level for coffee, the tea type for tea.
const items = () => database.collection('items');
// `method` is the brew method for coffee, 'western' or 'gongfu' for tea.
const brews = () => database.collection('brews');

// Parses a URL/form id; anything that is not a valid ObjectId becomes null (→ 404).
function toObjectId(value) {
  const str = String(value ?? '');
  return /^[a-f0-9]{24}$/i.test(str) ? new ObjectId(str) : null;
}

// Adds a string `id` so views and the engine never deal with ObjectIds directly.
const withId = (doc) => doc && { ...doc, id: doc._id.toHexString() };

const isDuplicateKey = (err) => err?.code === 11000;

module.exports = { connect, close, users, items, brews, toObjectId, withId, isDuplicateKey };
