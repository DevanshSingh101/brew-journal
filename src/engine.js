// Dial-in assistant: a rule engine that looks at a brew (and the brews before it)
// and proposes ONE main adjustment for the next attempt, the way a barista would.
// Pure functions only — no database or HTTP — so every rule is unit-testable.

const {
  COFFEE_METHODS, TEA_TYPES, coffeeTargetTemp, teaStyle, teaTimeRange, mid, round,
} = require('./profiles');
const { howToReach } = require('./temperature');
const { formatDuration, num } = require('./format');

const DAY = 86400000;
const time = (v) => new Date(v).getTime();

function freshness(item, today = new Date()) {
  if (item.kind !== 'coffee' || !item.roast_date) return null;
  const days = Math.floor((today - new Date(`${item.roast_date}T00:00:00`)) / DAY);
  if (days < 0) return null;
  if (days < 4) return { days, label: 'Resting', tip: 'Freshly roasted beans are still releasing CO₂, which causes uneven, sour brews. Best from day 4 (espresso: day 7).' };
  if (days <= 21) return { days, label: 'Peak', tip: 'Prime window — flavour is at its best.' };
  if (days <= 45) return { days, label: 'Fading', tip: 'Aromatics are fading. A slightly finer grind helps compensate.' };
  return { days, label: 'Stale', tip: 'Old beans taste flat and papery. Grind finer, and consider fresher beans.' };
}

// Grind settings are free text; when numeric we propose a concrete value,
// assuming a lower number means finer (true for most grinders).
function shiftGrind(grind, direction) {
  const word = direction < 0 ? 'finer' : 'coarser';
  const value = String(grind ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(value)) {
    return { to: value, text: `one step ${word}${value ? ` than “${value}”` : ''}` };
  }
  const n = Number(value);
  const step = n <= 5 ? 0.5 : n <= 15 ? 1 : 2;
  const to = num(Math.max(0, n + direction * step));
  return { to, text: `${value} → ${to} (assuming lower is finer on your grinder)` };
}

function tempText(tempC, ml) {
  const how = howToReach(tempC, ml);
  const cues = [];
  if (how.stage && how.stage.key !== 'cold') cues.push(how.stage.name.toLowerCase());
  if (how.rest) cues.push(`boil then rest ~${how.rest} min`);
  if (how.mix) cues.push(`${how.mix.hot} ml boiling + ${how.mix.cold} ml cold`);
  return `${num(tempC, 0)} °C${cues.length ? ` (${cues.join(', or ')})` : ''}`;
}

function newPlan(brew) {
  return {
    dialedIn: false,
    headline: '',
    reason: '',
    changes: [],
    alternatives: [],
    checks: [],
    notes: [],
    trend: null,
    next: {
      method: brew.method,
      dose_g: brew.dose_g,
      water_ml: brew.water_ml,
      grind: brew.grind || '',
      temp_c: brew.temp_c,
      time_s: brew.time_s,
      infusion: brew.infusion || 1,
    },
  };
}

function setTemp(plan, brew, to) {
  plan.next.temp_c = to;
  plan.changes.push(`Water: ${num(brew.temp_c, 0)} → ${tempText(to, brew.water_ml)}`);
}

function setTime(plan, brew, to) {
  plan.next.time_s = to;
  plan.changes.push(`Time: ${formatDuration(brew.time_s)} → ${formatDuration(to)}`);
}

function setDose(plan, brew, to, unit) {
  plan.next.dose_g = to;
  plan.changes.push(`${unit}: ${num(brew.dose_g)} g → ${num(to)} g`);
}

function setGrind(plan, brew, direction) {
  const g = shiftGrind(brew.grind, direction);
  plan.next.grind = g.to;
  plan.changes.push(`Grind: ${g.text}`);
}

function coffeePlan(brew, item, plan) {
  const p = COFFEE_METHODS[brew.method];
  const ratio = brew.water_ml / brew.dose_g;
  const target = coffeeTargetTemp(brew.method, item.variety);
  const range = (r, f = (x) => x) => `${f(r[0])}–${f(r[1])}`;

  if (ratio < p.ratio[0] * 0.95) plan.checks.push(`Ratio 1:${num(ratio)} is stronger than usual for ${p.label} (1:${range(p.ratio)}).`);
  if (ratio > p.ratio[1] * 1.05) plan.checks.push(`Ratio 1:${num(ratio)} is weaker than usual for ${p.label} (1:${range(p.ratio)}).`);
  if (brew.temp_c < p.temp[0] - 1) plan.checks.push(`${num(brew.temp_c, 0)} °C is cool for ${p.label} (${range(p.temp)} °C).`);
  if (brew.temp_c > p.temp[1] + 1) plan.checks.push(`${num(brew.temp_c, 0)} °C is hot for ${p.label} (${range(p.temp)} °C).`);
  if (brew.time_s < p.time[0] * 0.9) plan.checks.push(`${formatDuration(brew.time_s)} is short for ${p.label} (${range(p.time, formatDuration)}).`);
  if (brew.time_s > p.time[1] * 1.1) plan.checks.push(`${formatDuration(brew.time_s)} is long for ${p.label} (${range(p.time, formatDuration)}).`);

  if (brew.taste === 'sour') {
    plan.reason = 'Sourness means under-extraction: the water did not pull enough out of the coffee.';
    if (!p.cold && brew.temp_c < p.temp[0]) {
      plan.headline = 'Use hotter water';
      setTemp(plan, brew, target);
    } else if (p.immersion) {
      plan.headline = 'Steep longer';
      setTime(plan, brew, brew.time_s + p.timeStep);
      plan.alternatives.push('Or grind one step finer and keep the time the same.');
    } else {
      plan.headline = 'Grind finer';
      setGrind(plan, brew, -1);
      if (brew.method === 'espresso') plan.notes.push('A finer grind slows the shot — aim for 27–30 s.');
      if (!p.cold && brew.temp_c < p.temp[1]) plan.alternatives.push(`Or raise the water to ${tempText(Math.min(p.temp[1], brew.temp_c + 2), brew.water_ml)}.`);
    }
  } else if (brew.taste === 'bitter') {
    plan.reason = 'Bitterness and harshness mean over-extraction: too much was pulled out of the coffee.';
    if (!p.cold && brew.temp_c > p.temp[1]) {
      plan.headline = 'Use cooler water';
      setTemp(plan, brew, target);
    } else if (!p.cold && item.variety === 'dark' && brew.temp_c > p.temp[0]) {
      plan.headline = 'Use cooler water';
      plan.reason += ' Dark roasts extract easily, so temperature is the first lever.';
      setTemp(plan, brew, Math.max(p.temp[0], brew.temp_c - 3));
    } else if (p.immersion) {
      plan.headline = 'Steep shorter';
      setTime(plan, brew, Math.max(30, brew.time_s - p.timeStep));
      plan.alternatives.push('Or grind one step coarser and keep the time the same.');
    } else {
      plan.headline = 'Grind coarser';
      setGrind(plan, brew, +1);
      if (brew.method === 'espresso') plan.notes.push('A coarser grind speeds the shot up — aim for 25–28 s.');
      if (!p.cold && brew.temp_c > p.temp[0]) plan.alternatives.push(`Or lower the water to ${tempText(Math.max(p.temp[0], brew.temp_c - 2), brew.water_ml)}.`);
    }
  } else if (brew.strength === 'weak') {
    plan.reason = 'Taste is balanced, so extraction is fine — only the concentration needs changing.';
    if (brew.method === 'espresso') {
      plan.headline = 'Pull a shorter shot';
      const to = round(brew.dose_g * Math.max(1.5, ratio - 0.3), 1);
      plan.next.water_ml = to;
      plan.changes.push(`Yield: ${num(brew.water_ml)} g → ${num(to)} g (same dose)`);
    } else {
      plan.headline = 'Use more coffee';
      setDose(plan, brew, round(brew.water_ml / Math.max(2, ratio - 1), 0.5), 'Coffee');
    }
  } else if (brew.strength === 'strong') {
    plan.reason = 'Taste is balanced, so extraction is fine — only the concentration needs changing.';
    if (brew.method === 'espresso') {
      plan.headline = 'Pull a longer shot';
      const to = round(brew.dose_g * (ratio + 0.3), 1);
      plan.next.water_ml = to;
      plan.changes.push(`Yield: ${num(brew.water_ml)} g → ${num(to)} g (same dose)`);
    } else {
      plan.headline = 'Use less coffee';
      setDose(plan, brew, round(brew.water_ml / (ratio + 1), 0.5), 'Coffee');
    }
  } else {
    dialed(plan, brew);
  }

  if (brew.taste !== 'balanced' && brew.strength !== 'good') {
    plan.alternatives.push(`Strength felt ${brew.strength === 'weak' ? 'weak' : 'strong'} too — fix the taste first, then adjust the amount of coffee. Change one thing at a time.`);
  }

  const fresh = freshness(item);
  if (fresh && fresh.label !== 'Peak' && brew.taste !== 'balanced') plan.notes.push(`Beans are ${fresh.days} days off roast (${fresh.label.toLowerCase()}). ${fresh.tip}`);
}

function teaPlan(brew, item, plan) {
  const t = TEA_TYPES[item.variety];
  const s = teaStyle(item.variety, brew.method);
  const gongfu = brew.method === 'gongfu' && t.gongfu;
  const leaf = (brew.dose_g / brew.water_ml) * 100;
  const [tLo, tHi] = teaTimeRange(item.variety, brew.method, brew.infusion || 1);
  const label = `${t.label.toLowerCase()} tea`;
  const shorter = Math.max(5, round(brew.time_s * 0.75, 5));
  const longer = round(brew.time_s * 1.25, 5) || brew.time_s + 5;
  const leafFor = (perHundred) => round((brew.water_ml * perHundred) / 100, 0.5);

  if (brew.temp_c > t.temp[1] + 1) plan.checks.push(`${num(brew.temp_c, 0)} °C is hot for ${label} (${t.temp[0]}–${t.temp[1]} °C).`);
  if (brew.temp_c < t.temp[0] - 1) plan.checks.push(`${num(brew.temp_c, 0)} °C is cool for ${label} (${t.temp[0]}–${t.temp[1]} °C).`);
  if (leaf < s.leaf[0] * 0.9) plan.checks.push(`${num(leaf)} g per 100 ml is light on leaf (${s.leaf[0]}–${s.leaf[1]} g).`);
  if (leaf > s.leaf[1] * 1.1) plan.checks.push(`${num(leaf)} g per 100 ml is heavy on leaf (${s.leaf[0]}–${s.leaf[1]} g).`);
  if (brew.time_s > tHi * 1.15) plan.checks.push(`${formatDuration(brew.time_s)} is a long steep here (${formatDuration(tLo)}–${formatDuration(tHi)}).`);
  if (brew.time_s < tLo * 0.85) plan.checks.push(`${formatDuration(brew.time_s)} is a short steep here (${formatDuration(tLo)}–${formatDuration(tHi)}).`);

  if (brew.taste === 'bitter') {
    plan.reason = 'Bitterness comes from water that is too hot or a steep that is too long.';
    if (brew.temp_c > t.temp[1]) {
      plan.headline = 'Use cooler water';
      setTemp(plan, brew, round(mid(t.temp)));
    } else if (t.heatSensitive && brew.temp_c > t.temp[0]) {
      plan.headline = 'Use cooler water';
      plan.reason += ` ${t.label} tea is delicate, so temperature matters most.`;
      setTemp(plan, brew, Math.max(t.temp[0], brew.temp_c - 5));
    } else {
      plan.headline = 'Steep shorter';
      setTime(plan, brew, shorter);
    }
  } else if (brew.taste === 'astringent') {
    plan.reason = 'A drying, puckering feel comes from tannins, which keep extracting the longer the leaf steeps.';
    plan.headline = 'Steep shorter';
    setTime(plan, brew, shorter);
    plan.alternatives.push(`Or use a little less leaf (${num(leafFor(leaf * 0.85))} g).`);
  } else if (brew.taste === 'flat') {
    plan.reason = 'Flat, thin tea is under-extracted: not enough flavour left the leaf.';
    if (brew.temp_c < t.temp[0]) {
      plan.headline = 'Use hotter water';
      setTemp(plan, brew, round(mid(t.temp)));
    } else if (leaf < s.leaf[0]) {
      plan.headline = 'Use more leaf';
      setDose(plan, brew, leafFor(mid(s.leaf)), 'Leaf');
    } else if (brew.time_s < tHi) {
      plan.headline = 'Steep longer';
      setTime(plan, brew, longer);
    } else {
      plan.headline = 'Use more leaf';
      setDose(plan, brew, leafFor(leaf * 1.2), 'Leaf');
    }
    if (brew.temp_c < t.temp[1] && plan.headline !== 'Use hotter water') {
      plan.alternatives.push(`Or use hotter water: ${tempText(Math.min(t.temp[1], brew.temp_c + 5), brew.water_ml)}.`);
    }
  } else if (brew.strength === 'weak') {
    plan.reason = 'The flavour is balanced but dilute.';
    if (leaf < s.leaf[1]) {
      plan.headline = 'Use more leaf';
      setDose(plan, brew, leafFor(Math.min(s.leaf[1] * 1.1, leaf * 1.2)), 'Leaf');
    } else {
      plan.headline = 'Steep longer';
      setTime(plan, brew, longer);
    }
  } else if (brew.strength === 'strong') {
    plan.reason = 'The flavour is balanced but too concentrated.';
    if (brew.time_s > tLo) {
      plan.headline = 'Steep shorter';
      setTime(plan, brew, shorter);
    } else {
      plan.headline = 'Use less leaf';
      setDose(plan, brew, leafFor(leaf * 0.8), 'Leaf');
    }
  } else {
    dialed(plan, brew);
  }

  if (gongfu) {
    const n = brew.infusion || 1;
    plan.next.infusion = n + 1;
    plan.next.time_s += s.step;
    plan.notes.push(`Gongfu: infusion ${n + 1} needs about ${s.step} s longer — steep for ${formatDuration(plan.next.time_s)}.`);
  }
}

function dialed(plan, brew) {
  plan.dialedIn = brew.rating >= 4;
  if (plan.dialedIn) {
    plan.headline = 'Dialed in — repeat this recipe';
    plan.reason = 'Taste and strength are both on target and you rated it highly.';
  } else {
    plan.headline = 'Balanced, but not loved yet';
    plan.reason = 'Extraction and strength are on target, so what is left is fine-tuning or the ingredient itself.';
    plan.alternatives.push(`Try the water 2 °C warmer for more sweetness and body, or 2 °C cooler for more clarity.`);
  }
}

// Compare with the most recent earlier brew of the same item, method and infusion.
function trend(brew, history) {
  const prev = history
    .filter((h) => h.id !== brew.id && h.method === brew.method && (h.infusion || 1) === (brew.infusion || 1)
      && (time(h.created_at) < time(brew.created_at) || (time(h.created_at) === time(brew.created_at) && h.id < brew.id)))
    .sort((a, b) => time(b.created_at) - time(a.created_at))[0];
  if (!prev) return null;

  const fields = [
    ['grind', 'grind', (v) => v || '—'],
    ['temp_c', 'water', (v) => `${num(v, 0)} °C`],
    ['time_s', 'time', formatDuration],
    ['dose_g', 'dose', (v) => `${num(v)} g`],
    ['water_ml', 'water amount', (v) => `${num(v)} ml`],
  ];
  const changed = fields
    .filter(([key]) => String(prev[key] ?? '') !== String(brew[key] ?? ''))
    .map(([key, label, f]) => `${label} ${f(prev[key])} → ${f(brew[key])}`);

  const delta = brew.rating - prev.rating;
  const rating = `rating ${prev.rating} → ${brew.rating}`;
  if (!changed.length) return `Same recipe as your previous brew; ${rating}.`;
  let text = `Since your previous brew you changed ${changed.join(', ')}; ${rating}. `;
  if (delta > 0) text += 'That helped — keep going in that direction.';
  else if (delta < 0) text += 'It got worse — move back toward the previous recipe.';
  else text += 'No clear difference yet.';
  if (changed.length > 1) text += ' Changing one variable at a time makes it clear what made the difference.';
  return text;
}

function suggest(brew, item, history = []) {
  const plan = newPlan(brew);
  if (item.kind === 'coffee') coffeePlan(brew, item, plan);
  else teaPlan(brew, item, plan);
  plan.trend = trend(brew, history);
  return plan;
}

// Highest rated brew, most recent first on ties.
function bestBrew(brews) {
  return [...brews].sort((a, b) => b.rating - a.rating || time(b.created_at) - time(a.created_at))[0] || null;
}

module.exports = { suggest, freshness, shiftGrind, trend, bestBrew, tempText };
