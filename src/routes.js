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

// Every lookup filters on the owner, so other users' ids behave like missing ones.
async function ownedItem(req, id) {
  const _id = db.toObjectId(id);
  const item = _id && await db.items().findOne({ _id, user_id: req.user._id });
  if (!item) throw new NotFound('That coffee or tea does not exist, or it is not yours.');
  return db.withId(item);
}

async function ownedBrew(req, id) {
  const _id = db.toObjectId(id);
  const brew = _id && await db.brews().findOne({ _id, user_id: req.user._id });
  if (!brew) throw new NotFound('That brew does not exist, or it is not yours.');
  return db.withId(brew);
}

const itemBrews = async (itemId) => (await db.brews().find({ item_id: itemId }).sort({ created_at: -1, _id: -1 }).toArray()).map(db.withId);

// ---------- Home ----------

router.get('/', wrap(async (req, res) => {
  if (!req.user) return res.render('home', { title: 'Brew Journal' });
  const [items, stats, recent] = await Promise.all([
    db.items().find({ user_id: req.user._id }).sort({ created_at: -1 }).toArray(),
    db.brews().aggregate([
      { $match: { user_id: req.user._id } },
      { $group: { _id: '$item_id', count: { $sum: 1 }, bestRating: { $max: '$rating' } } },
    ]).toArray(),
    db.brews().find({ user_id: req.user._id }).sort({ created_at: -1, _id: -1 }).limit(6).toArray(),
  ]);
  const statsByItem = new Map(stats.map((s) => [s._id.toHexString(), s]));
  const shelf = items.map((i) => {
    const s = statsByItem.get(i._id.toHexString());
    return { ...db.withId(i), fresh: freshness(i), count: s?.count || 0, bestRating: s?.bestRating || null };
  });
  const byId = new Map(shelf.map((i) => [i.id, i]));
  res.render('dashboard', {
    title: 'Your brews',
    shelf,
    recent: recent.map((b) => ({ ...db.withId(b), item: byId.get(b.item_id.toHexString()) })),
  });
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
  const { insertedId } = await db.items().insertOne({
    user_id: req.user._id,
    kind: values.kind,
    name: values.name,
    variety: values.variety,
    origin: values.origin || null,
    roast_date: values.roast_date || null,
    notes: values.notes || null,
    created_at: new Date(),
  });
  req.flash(`${values.name} added. Log your first brew.`);
  res.redirect(`/brews/new?item=${insertedId}`);
}));

router.get('/items/:id', requireUser, wrap(async (req, res) => {
  const item = await ownedItem(req, req.params.id);
  const brews = await itemBrews(item._id);
  const best = bestBrew(brews);
  const latestPlan = brews[0] ? suggest(brews[0], item, brews) : null;
  res.render('item', { title: item.name, item, brews, best, fresh: freshness(item), latestPlan });
}));

router.post('/items/:id/delete', requireUser, wrap(async (req, res) => {
  const item = await ownedItem(req, req.params.id);
  // Brews first: if the second step fails we are left with an empty item, never orphaned brews.
  await db.brews().deleteMany({ item_id: item._id, user_id: req.user._id });
  await db.items().deleteOne({ _id: item._id, user_id: req.user._id });
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
    const items = (await db.items().find({ user_id: req.user._id }, { projection: { name: 1, kind: 1 } }).sort({ name: 1 }).toArray()).map(db.withId);
    if (!items.length) {
      req.flash('Add a coffee or tea first.');
      return res.redirect('/items/new');
    }
    return res.render('pick_item', { title: 'What are you brewing?', items });
  }

  const item = await ownedItem(req, req.query.item);
  const brews = await itemBrews(item._id);

  // Pre-fill priority: an applied suggestion, then the last brew, then a reference recipe.
  if (req.query.from) {
    const from = await ownedBrew(req, req.query.from);
    if (!from.item_id.equals(item._id)) throw new NotFound('That brew belongs to a different coffee or tea.');
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
    const { insertedId } = await db.brews().insertOne({
      user_id: req.user._id,
      item_id: item._id,
      method: values.method,
      dose_g: values.dose_g,
      water_ml: values.water_ml,
      grind: values.grind || null,
      temp_c: values.temp_c,
      temp_cue: values.temp_cue || null,
      time_s: values.time_s,
      infusion: values.infusion,
      taste: values.taste,
      strength: values.strength,
      rating: values.rating,
      notes: values.notes || null,
      nonce: values.nonce,
      created_at: new Date(),
    });
    res.redirect(`/brews/${insertedId}`);
  } catch (err) {
    if (!db.isDuplicateKey(err)) throw err;
    // Same form submitted twice (double click, refresh): show the brew that was already saved.
    const existing = await db.brews().findOne({ user_id: req.user._id, nonce: values.nonce }, { projection: { _id: 1 } });
    res.redirect(`/brews/${existing._id}`);
  }
}));

router.get('/brews/:id', requireUser, wrap(async (req, res) => {
  const brew = await ownedBrew(req, req.params.id);
  const item = await ownedItem(req, brew.item_id);
  const history = await itemBrews(item._id);
  const plan = suggest(brew, item, history);
  res.render('brew', { title: `${item.name} — brew`, brew, item, plan, isBest: history.length > 1 && bestBrew(history)?.id === brew.id });
}));

router.post('/brews/:id/delete', requireUser, wrap(async (req, res) => {
  const brew = await ownedBrew(req, req.params.id);
  await db.brews().deleteOne({ _id: brew._id, user_id: req.user._id });
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
