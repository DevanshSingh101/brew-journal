const crypto = require('node:crypto');
const express = require('express');
const db = require('./db');
const { requireUser } = require('./auth');
const { validateItem, validateBrew } = require('./validate');
const { suggest, freshness, bestBrew } = require('./engine');
const { recommend, COFFEE_METHODS, ROAST_LEVELS, TEA_TYPES } = require('./profiles');
const { howToReach } = require('./temperature');
const { durationInput } = require('./format');

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

async function ownedBrew(req, id) {
  const brew = await db.one('SELECT * FROM brews WHERE id = $1 AND user_id = $2', [toId(id), req.user.id]);
  if (!brew) throw new NotFound('That brew does not exist, or it is not yours.');
  return brew;
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

// ---------- Brews ----------

function brewFormValues(recipe) {
  return {
    method: recipe.method,
    dose_g: recipe.dose_g,
    water_ml: recipe.water_ml,
    grind: recipe.grind || '',
    temp_c: recipe.temp_c,
    temp_cue: '',
    time: durationInput(recipe.time_s),
    infusion: recipe.infusion || 1,
  };
}

function renderBrewForm(res, item, values, errors = {}, source = null, status = 200) {
  res.status(status).render('brew_form', {
    title: `Brew ${item.name}`, item, values: { ...values, nonce: crypto.randomUUID() }, errors, source,
  });
}

router.get('/brews/new', requireUser, wrap(async (req, res) => {
  if (!req.query.item) {
    const items = await db.query('SELECT id, name, kind FROM items WHERE user_id = $1 ORDER BY name', [req.user.id]);
    if (!items.length) {
      req.flash('Add a coffee or tea first.');
      return res.redirect('/items/new');
    }
    return res.render('pick_item', { title: 'What are you brewing?', items });
  }

  const item = await ownedItem(req, req.query.item);
  const brews = await itemBrews(item.id);

  // Pre-fill priority: an applied suggestion, then the last brew, then a reference recipe.
  if (req.query.from) {
    const from = await ownedBrew(req, req.query.from);
    if (from.item_id !== item.id) throw new NotFound('That brew belongs to a different coffee or tea.');
    const plan = suggest(from, item, brews);
    return renderBrewForm(res, item, brewFormValues(plan.next), {}, { kind: 'suggestion', headline: plan.headline });
  }
  if (brews[0]) return renderBrewForm(res, item, brewFormValues(brews[0]), {}, { kind: 'last' });
  const rec = item.kind === 'coffee'
    ? recommend({ kind: 'coffee', method: 'pourover', roast: item.variety })
    : recommend({ kind: 'tea', type: item.variety, style: 'western' });
  renderBrewForm(res, item, brewFormValues(rec), {}, { kind: 'reference' });
}));

router.post('/brews', requireUser, wrap(async (req, res) => {
  const item = await ownedItem(req, req.body.item_id);
  const { values, errors } = validateBrew(req.body, item);
  if (Object.keys(errors).length) {
    return renderBrewForm(res, item, { ...values, temp_c: req.body.temp_c, time: req.body.time, dose_g: req.body.dose_g, water_ml: req.body.water_ml }, errors, null, 422);
  }
  try {
    const brew = await db.one(
      `INSERT INTO brews (user_id, item_id, method, dose_g, water_ml, grind, temp_c, temp_cue, time_s, infusion, taste, strength, rating, notes, nonce, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
      [req.user.id, item.id, values.method, values.dose_g, values.water_ml, values.grind || null, values.temp_c, values.temp_cue || null,
        values.time_s, values.infusion, values.taste, values.strength, values.rating, values.notes || null, values.nonce, new Date().toISOString()],
    );
    res.redirect(`/brews/${brew.id}`);
  } catch (err) {
    if (!db.isUniqueViolation(err)) throw err;
    // Same form submitted twice (double click, refresh): show the brew that was already saved.
    const existing = await db.one('SELECT id FROM brews WHERE user_id = $1 AND nonce = $2', [req.user.id, values.nonce]);
    res.redirect(`/brews/${existing.id}`);
  }
}));

router.get('/brews/:id', requireUser, wrap(async (req, res) => {
  const brew = await ownedBrew(req, req.params.id);
  const item = await ownedItem(req, brew.item_id);
  const history = await itemBrews(item.id);
  const plan = suggest(brew, item, history);
  res.render('brew', { title: `${item.name} — brew`, brew, item, plan, isBest: bestBrew(history)?.id === brew.id });
}));

router.post('/brews/:id/delete', requireUser, wrap(async (req, res) => {
  const brew = await ownedBrew(req, req.params.id);
  await db.query('DELETE FROM brews WHERE id = $1 AND user_id = $2', [brew.id, req.user.id]);
  req.flash('Brew deleted.');
  res.redirect(`/items/${brew.item_id}`);
}));

// ---------- Guides (public) ----------

router.get('/guide', (req, res) => {
  const q = req.query;
  const kind = q.kind === 'tea' ? 'tea' : 'coffee';
  const opts = {
    kind,
    method: COFFEE_METHODS[q.method] ? q.method : 'pourover',
    roast: ROAST_LEVELS[q.roast] ? q.roast : 'medium',
    type: TEA_TYPES[q.type] ? q.type : 'green',
    style: q.style === 'gongfu' ? 'gongfu' : 'western',
  };
  const ml = Math.round(Number(q.ml));
  if (ml >= 20 && ml <= 3000) opts.ml = ml;
  const rec = recommend(opts);
  res.render('guide', { title: 'Brew calculator', opts, rec, how: howToReach(rec.temp_c, rec.water_ml) });
});

router.get('/water', (req, res) => res.render('water', { title: 'Water temperature without a thermometer' }));

module.exports = { router, NotFound };
