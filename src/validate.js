// Form parsing and validation. Each function returns { values, errors };
// `errors` maps field name → message and is empty when the input is valid.

const {
  COFFEE_METHODS, ROAST_LEVELS, TEA_TYPES, TEA_STYLES, COFFEE_TASTES, TEA_TASTES, STRENGTHS,
} = require('./profiles');
const { stageByKey } = require('./temperature');
const { parseDuration } = require('./format');

const text = (v, max) => String(v ?? '').trim().slice(0, max);

function number(raw, { min, max, label }, errors, field) {
  const str = String(raw ?? '').trim();
  if (!str) { errors[field] = `${label} is required.`; return null; }
  const n = Number(str);
  if (!Number.isFinite(n)) { errors[field] = `${label} must be a number.`; return null; }
  if (n < min || n > max) { errors[field] = `${label} must be between ${min} and ${max}.`; return null; }
  return n;
}

function validateCredentials(body) {
  const values = { email: text(body.email, 200).toLowerCase(), password: String(body.password ?? '') };
  const errors = {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.email = 'Enter a valid email address.';
  if (values.password.length < 8) errors.password = 'Password must be at least 8 characters.';
  if (values.password.length > 200) errors.password = 'Password is too long.';
  return { values, errors };
}

function validateItem(body) {
  const kind = body.kind === 'tea' ? 'tea' : 'coffee';
  const values = {
    kind,
    name: text(body.name, 80),
    variety: text(body.variety, 20),
    origin: text(body.origin, 80),
    roast_date: kind === 'coffee' ? text(body.roast_date, 10) : '',
    notes: text(body.notes, 500),
  };
  const errors = {};
  if (!values.name) errors.name = 'Give it a name.';
  const varieties = kind === 'coffee' ? ROAST_LEVELS : TEA_TYPES;
  if (!varieties[values.variety]) errors.variety = kind === 'coffee' ? 'Pick a roast level.' : 'Pick a tea type.';
  if (values.roast_date) {
    const d = new Date(`${values.roast_date}T00:00:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values.roast_date) || Number.isNaN(d.getTime())) errors.roast_date = 'Use a valid date.';
    else if (d > new Date()) errors.roast_date = 'Roast date cannot be in the future.';
  }
  return { values, errors };
}

function validateBrew(body, item) {
  const errors = {};
  const isCoffee = item.kind === 'coffee';
  const methods = isCoffee ? COFFEE_METHODS : TEA_STYLES;
  const tastes = isCoffee ? COFFEE_TASTES : TEA_TASTES;

  const values = {
    method: text(body.method, 20),
    grind: isCoffee ? text(body.grind, 30) : '',
    temp_cue: text(body.temp_cue, 20),
    taste: text(body.taste, 20),
    strength: text(body.strength, 20),
    notes: text(body.notes, 500),
    nonce: text(body.nonce, 64),
  };

  if (!methods[values.method]) errors.method = 'Pick a brew method.';
  if (!isCoffee && values.method === 'gongfu' && !TEA_TYPES[item.variety].gongfu) {
    errors.method = `${TEA_TYPES[item.variety].label} is usually brewed western style.`;
  }

  values.dose_g = number(body.dose_g, { min: 0.5, max: 500, label: isCoffee ? 'Coffee' : 'Leaf' }, errors, 'dose_g');
  values.water_ml = number(body.water_ml, { min: 5, max: 5000, label: 'Water' }, errors, 'water_ml');

  // Temperature: if the user described the water instead of measuring it,
  // estimate from the bubble stage; otherwise require a reading.
  const stage = stageByKey(values.temp_cue);
  if (stage) {
    values.temp_c = stage.est;
  } else {
    values.temp_cue = '';
    if (String(body.temp_c ?? '').trim()) {
      values.temp_c = number(body.temp_c, { min: 0, max: 100, label: 'Temperature' }, errors, 'temp_c');
    } else {
      errors.temp_c = 'Enter a temperature, or pick what the water looked like.';
    }
  }

  values.time_s = parseDuration(body.time);
  if (values.time_s == null) errors.time = 'Enter a time like 45, 2:30 or 16h.';
  else if (values.time_s < 1 || values.time_s > 48 * 3600) errors.time = 'Time must be between 1 second and 48 hours.';

  values.infusion = values.method === 'gongfu' ? Math.round(Number(body.infusion) || 1) : 1;
  if (values.infusion < 1 || values.infusion > 30) errors.infusion = 'Infusion must be between 1 and 30.';

  if (!tastes[values.taste]) errors.taste = 'How did it taste?';
  if (!STRENGTHS[values.strength]) errors.strength = 'How strong was it?';
  values.rating = Math.round(Number(body.rating));
  if (!(values.rating >= 1 && values.rating <= 5)) errors.rating = 'Rate it from 1 to 5.';
  if (!/^[a-f0-9-]{16,64}$/i.test(values.nonce)) errors.form = 'This form expired. Please submit it again.';

  return { values, errors };
}

module.exports = { validateCredentials, validateItem, validateBrew };
