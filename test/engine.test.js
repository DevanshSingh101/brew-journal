const test = require('node:test');
const assert = require('node:assert/strict');
const { suggest, freshness, shiftGrind, bestBrew } = require('../src/engine');
const { mixFor, restMinutes, stageFor } = require('../src/temperature');
const { parseDuration, formatDuration } = require('../src/format');
const { validateBrew } = require('../src/validate');
const { recommend } = require('../src/profiles');

const coffee = { kind: 'coffee', variety: 'medium', roast_date: null };
const pour = {
  id: 1, method: 'pourover', dose_g: 15, water_ml: 250, grind: '18', temp_c: 94, time_s: 180,
  infusion: 1, taste: 'balanced', strength: 'good', rating: 4, created_at: '2026-10-01T10:00:00Z',
};

test('sour pour-over → grind finer', () => {
  const plan = suggest({ ...pour, taste: 'sour', rating: 2 }, coffee);
  assert.equal(plan.headline, 'Grind finer');
  assert.equal(plan.next.grind, '16');
});

test('sour with cool water → raise temperature first', () => {
  const plan = suggest({ ...pour, taste: 'sour', temp_c: 85 }, { ...coffee, variety: 'light' });
  assert.equal(plan.headline, 'Use hotter water');
  assert.equal(plan.next.temp_c, 96); // light roast targets the top of the range
});

test('bitter dark roast → cooler water before grind', () => {
  const plan = suggest({ ...pour, taste: 'bitter' }, { ...coffee, variety: 'dark' });
  assert.equal(plan.headline, 'Use cooler water');
  assert.equal(plan.next.temp_c, 92);
});

test('sour French press → steep longer, not grind', () => {
  const plan = suggest({ ...pour, method: 'frenchpress', water_ml: 350, dose_g: 25, time_s: 240, taste: 'sour' }, coffee);
  assert.equal(plan.headline, 'Steep longer');
  assert.equal(plan.next.time_s, 300);
});

test('balanced but weak → more coffee, same water', () => {
  const plan = suggest({ ...pour, strength: 'weak' }, coffee);
  assert.equal(plan.headline, 'Use more coffee');
  assert.equal(plan.next.water_ml, 250);
  assert.ok(plan.next.dose_g > 15);
});

test('weak espresso → shorter yield, same dose', () => {
  const plan = suggest({ ...pour, method: 'espresso', dose_g: 18, water_ml: 40, time_s: 28, strength: 'weak' }, coffee);
  assert.equal(plan.headline, 'Pull a shorter shot');
  assert.equal(plan.next.dose_g, 18);
  assert.ok(plan.next.water_ml < 40);
});

test('balanced, good and rated 4+ → dialed in, unchanged recipe', () => {
  const plan = suggest(pour, coffee);
  assert.equal(plan.dialedIn, true);
  assert.deepEqual(plan.changes, []);
});

test('bitter green tea → cooler water (heat sensitive)', () => {
  const plan = suggest({ ...pour, method: 'western', dose_g: 3, water_ml: 250, grind: '', temp_c: 80, time_s: 120, taste: 'bitter' }, { kind: 'tea', variety: 'green' });
  assert.equal(plan.headline, 'Use cooler water');
  assert.equal(plan.next.temp_c, 75);
});

test('bitter black tea → shorter steep (robust tea)', () => {
  const plan = suggest({ ...pour, method: 'western', dose_g: 3, water_ml: 250, grind: '', temp_c: 95, time_s: 240, taste: 'bitter' }, { kind: 'tea', variety: 'black' });
  assert.equal(plan.headline, 'Steep shorter');
  assert.equal(plan.next.time_s, 180);
});

test('gongfu → next infusion is one longer step', () => {
  const plan = suggest({ ...pour, method: 'gongfu', dose_g: 6, water_ml: 100, grind: '', temp_c: 95, time_s: 20, infusion: 2 }, { kind: 'tea', variety: 'oolong' });
  assert.equal(plan.next.infusion, 3);
  assert.equal(plan.next.time_s, 25);
});

test('out-of-range parameters are flagged', () => {
  const plan = suggest({ ...pour, method: 'western', dose_g: 3, water_ml: 250, temp_c: 100, time_s: 120 }, { kind: 'tea', variety: 'green' });
  assert.ok(plan.checks.some((c) => c.includes('hot for green tea')));
});

test('trend compares with the previous brew of the same recipe type', () => {
  const prev = { ...pour, id: 1, grind: '18', rating: 2, created_at: '2026-10-01T10:00:00Z' };
  const cur = { ...pour, id: 2, grind: '16', rating: 4, created_at: '2026-10-02T10:00:00Z' };
  const plan = suggest(cur, coffee, [cur, prev]);
  assert.match(plan.trend, /grind 18 → 16/);
  assert.match(plan.trend, /That helped/);
});

test('freshness windows', () => {
  const today = new Date('2026-10-27T12:00:00');
  assert.equal(freshness({ kind: 'coffee', roast_date: '2026-10-25' }, today).label, 'Resting');
  assert.equal(freshness({ kind: 'coffee', roast_date: '2026-10-15' }, today).label, 'Peak');
  assert.equal(freshness({ kind: 'coffee', roast_date: '2026-08-01' }, today).label, 'Stale');
  assert.equal(freshness({ kind: 'tea' }, today), null);
});

test('grind shifting handles numbers and free text', () => {
  assert.equal(shiftGrind('3', -1).to, '2.5');
  assert.equal(shiftGrind('12', +1).to, '13');
  assert.equal(shiftGrind('medium', -1).to, 'medium');
});

test('best brew picks highest rating, newest on ties', () => {
  const a = { id: 1, rating: 4, created_at: '2026-10-01' };
  const b = { id: 2, rating: 4, created_at: '2026-10-03' };
  const c = { id: 3, rating: 2, created_at: '2026-10-05' };
  assert.equal(bestBrew([a, b, c]).id, 2);
});

test('temperature helpers', () => {
  assert.deepEqual(mixFor(80, 400), { hot: 300, cold: 100, tapC: 20 });
  assert.equal(stageFor(75).key, 'shrimp');
  assert.equal(stageFor(100).key, 'boil');
  assert.equal(restMinutes(100), 0);
  assert.equal(restMinutes(80), 6);
});

test('durations parse and format', () => {
  assert.equal(parseDuration('2:30'), 150);
  assert.equal(parseDuration('45'), 45);
  assert.equal(parseDuration('16h'), 57600);
  assert.equal(parseDuration('1h30m'), 5400);
  assert.equal(parseDuration('soon'), null);
  assert.equal(formatDuration(150), '2:30');
});

test('validation estimates temperature from a bubble stage', () => {
  const { values, errors } = validateBrew({
    method: 'western', dose_g: '3', water_ml: '250', temp_cue: 'crab', time: '2:00',
    taste: 'balanced', strength: 'good', rating: '4', nonce: 'abcdef0123456789',
  }, { kind: 'tea', variety: 'white' });
  assert.deepEqual(errors, {});
  assert.equal(values.temp_c, 83);
});

test('validation rejects bad input', () => {
  const { errors } = validateBrew({ method: 'kettle', dose_g: 'lots', water_ml: '', time: 'soon', rating: '9' }, { kind: 'coffee', variety: 'light' });
  for (const field of ['method', 'dose_g', 'water_ml', 'temp_c', 'time', 'taste', 'strength', 'rating', 'form']) {
    assert.ok(errors[field], `expected an error for ${field}`);
  }
});

test('recommend scales to cup size', () => {
  const r = recommend({ kind: 'coffee', method: 'pourover', roast: 'medium', ml: 320 });
  assert.equal(r.water_ml, 320);
  assert.equal(r.dose_g, 20);
});
