const express = require('express');
const db = require('./db');
const { requireUser } = require('./auth');
const { validateItem } = require('./validate');
const { suggest, freshness, bestBrew } = require('./engine');

const router = express.Router();

class NotFound extends Error {}

// Wraps async handlers so rejected promises reach the error handler.
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const toId = (v) => (/^\d+$/.test(String(v)) ? Number(v) : -1);

async function ownedItem(req, id) {
  const item = await db.one('SELECT * FROM items WHERE id = $1 AND user_id = $2', [toId(id), req.user.id]);
  if (!item) throw new NotFound('That coffee or tea does not exist, or it is not yours.');
  return item;
}

const itemBrews = (itemId) => db.query('SELECT * FROM brews WHERE item_id = $1 ORDER BY created_at DESC, id DESC', [itemId]);

// ---------- Home ----------

router.get('/', wrap(async (req, res) => {
  if (!req.user) return res.render('home', { title: 'Brew Journal' });
  const items = await db.query('SELECT * FROM items WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
  const brews = await db.query('SELECT * FROM brews WHERE user_id = $1 ORDER BY created_at DESC, id DESC', [req.user.id]);
  const byItem = new Map(items.map((i) => [i.id, { ...i, brews: [], fresh: freshness(i) }]));
  for (const b of brews) byItem.get(b.item_id)?.brews.push(b);
  const shelf = [...byItem.values()].map((i) => ({ ...i, best: bestBrew(i.brews) }));
  const recent = brews.slice(0, 6).map((b) => ({ ...b, item: byItem.get(b.item_id) }));
  res.render('dashboard', { title: 'Your brews', shelf, recent });
}));

// ---------- Coffees & teas ----------

router.get('/items/new', requireUser, (req, res) => {
  const kind = req.query.kind === 'tea' ? 'tea' : 'coffee';
  res.render('item_form', { title: kind === 'tea' ? 'Add a tea' : 'Add a coffee', values: { kind }, errors: {} });
});

router.post('/items', requireUser, wrap(async (req, res) => {
  const { values, errors } = validateItem(req.body);
  if (Object.keys(errors).length) {
    return res.status(422).render('item_form', { title: values.kind === 'tea' ? 'Add a tea' : 'Add a coffee', values, errors });
  }
  const item = await db.one(
    `INSERT INTO items (user_id, kind, name, variety, origin, roast_date, notes, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [req.user.id, values.kind, values.name, values.variety, values.origin || null, values.roast_date || null, values.notes || null, new Date().toISOString()],
  );
  req.flash(`${values.name} added. Log your first brew.`);
  res.redirect(`/brews/new?item=${item.id}`);
}));

router.get('/items/:id', requireUser, wrap(async (req, res) => {
  const item = await ownedItem(req, req.params.id);
  const brews = await itemBrews(item.id);
  const best = bestBrew(brews);
  const latestPlan = brews[0] ? suggest(brews[0], item, brews) : null;
  res.render('item', { title: item.name, item, brews, best, fresh: freshness(item), latestPlan });
}));

router.post('/items/:id/delete', requireUser, wrap(async (req, res) => {
  const item = await ownedItem(req, req.params.id);
  await db.query('DELETE FROM items WHERE id = $1 AND user_id = $2', [item.id, req.user.id]);
  req.flash(`${item.name} and its brews were deleted.`);
  res.redirect('/');
}));

module.exports = { router, NotFound };
