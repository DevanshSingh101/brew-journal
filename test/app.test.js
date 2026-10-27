// End-to-end tests: the real Express app against a throwaway in-memory MongoDB.
const test = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo;
let server;
let base;
let db;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  db = require('../src/db');
  await db.connect();
  server = require('../server').listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await db.close();
  await mongo.stop();
});

// Minimal browser: keeps cookies, does not follow redirects.
function browser() {
  const jar = new Map();
  return async (path, form) => {
    const res = await fetch(base + path, {
      method: form ? 'POST' : 'GET',
      redirect: 'manual',
      headers: {
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(form && { 'content-type': 'application/x-www-form-urlencoded' }),
      },
      body: form && new URLSearchParams(form),
    });
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0];
      jar.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1));
    }
    return { status: res.status, location: res.headers.get('location'), html: await res.text() };
  };
}

const field = (html, name) => html.match(new RegExp(`name="${name}" value="([^"]*)"`))[1];

async function signUp(email) {
  const go = browser();
  const page = await go('/register');
  const res = await go('/register', { _csrf: field(page.html, '_csrf'), email, password: 'coffee123' });
  assert.equal(res.status, 302);
  return go;
}

async function addCoffee(go) {
  const page = await go('/items/new');
  const res = await go('/items', { _csrf: field(page.html, '_csrf'), kind: 'coffee', name: 'Guji', variety: 'light' });
  assert.equal(res.status, 302);
  return res.location.split('item=')[1];
}

async function logSourBrew(go, itemId) {
  const form = await go(`/brews/new?item=${itemId}`);
  const body = {
    _csrf: field(form.html, '_csrf'), nonce: field(form.html, 'nonce'), item_id: itemId,
    method: 'pourover', dose_g: '15', water_ml: '250', grind: '18', temp_c: '94', time: '3:00',
    taste: 'sour', strength: 'good', rating: '2',
  };
  return { body, res: await go('/brews', body) };
}

test('log a brew and get advice', async () => {
  const go = await signUp('a@example.com');
  const itemId = await addCoffee(go);
  const { res } = await logSourBrew(go, itemId);
  assert.equal(res.status, 302);
  const page = await go(res.location);
  assert.match(page.html, /Grind finer/);
  assert.match(page.html, /18 → 16/);
});

test('submitting the same brew form twice saves it once', async () => {
  const go = await signUp('b@example.com');
  const itemId = await addCoffee(go);
  const first = await logSourBrew(go, itemId);
  const again = await go('/brews', first.body);
  assert.equal(again.location, first.res.location);
  assert.equal(await db.brews().countDocuments({ nonce: first.body.nonce }), 1);
});

test('users cannot see or delete each other\'s brews', async () => {
  const owner = await signUp('c@example.com');
  const { res } = await logSourBrew(owner, await addCoffee(owner));
  const intruder = await signUp('d@example.com');
  assert.equal((await intruder(res.location)).status, 404);
  const page = await intruder('/');
  const del = await intruder(`${res.location}/delete`, { _csrf: field(page.html, '_csrf') });
  assert.equal(del.status, 404);
  assert.equal((await owner(res.location)).status, 200);
});

test('rejects duplicate emails, missing CSRF tokens and invalid brews', async () => {
  const go = await signUp('e@example.com');
  const other = browser();
  const reg = await other('/register');
  const dup = await other('/register', { _csrf: field(reg.html, '_csrf'), email: 'e@example.com', password: 'coffee123' });
  assert.equal(dup.status, 409);

  const itemId = await addCoffee(go);
  assert.equal((await go('/items', { kind: 'tea', name: 'x', variety: 'green' })).status, 403);

  const form = await go(`/brews/new?item=${itemId}`);
  const bad = await go('/brews', { _csrf: field(form.html, '_csrf'), nonce: field(form.html, 'nonce'), item_id: itemId, dose_g: 'lots' });
  assert.equal(bad.status, 422);
  assert.match(bad.html, /Coffee must be a number/);
});

test('logged-out users are sent to log in; malformed ids are 404', async () => {
  const anon = browser();
  assert.equal((await anon('/brews/new')).location, '/login');
  const go = await signUp('f@example.com');
  assert.equal((await go('/items/not-an-id')).status, 404);
});
