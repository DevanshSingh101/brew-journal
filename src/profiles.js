// Reference brewing parameters. Ranges are [low, high].
// Coffee ratio is grams of water per gram of coffee (1:16 → 16).
// Tea leaf is grams of leaf per 100 ml of water.

const COFFEE_METHODS = {
  espresso: {
    label: 'Espresso',
    ratio: [1.8, 2.5], temp: [90, 96], time: [25, 32],
    grind: 'fine', immersion: false, defaultWater: 36,
  },
  pourover: {
    label: 'Pour-over (V60, Chemex, Kalita)',
    ratio: [15, 17], temp: [92, 96], time: [150, 240],
    grind: 'medium-fine', immersion: false, defaultWater: 250,
  },
  aeropress: {
    label: 'AeroPress',
    ratio: [12, 16], temp: [80, 92], time: [90, 150],
    grind: 'medium-fine', immersion: true, timeStep: 30, defaultWater: 220,
  },
  frenchpress: {
    label: 'French press',
    ratio: [12, 16], temp: [93, 96], time: [240, 300],
    grind: 'coarse', immersion: true, timeStep: 60, defaultWater: 350,
  },
  moka: {
    label: 'Moka pot',
    ratio: [7, 10], temp: [90, 100], time: [180, 300],
    grind: 'fine-medium', immersion: false, defaultWater: 150,
  },
  coldbrew: {
    label: 'Cold brew (concentrate)',
    ratio: [5, 10], temp: [2, 25], time: [12 * 3600, 20 * 3600],
    grind: 'coarse', immersion: true, timeStep: 2 * 3600, defaultWater: 500, cold: true,
  },
};

const ROAST_LEVELS = {
  light: 'Light roast',
  medium: 'Medium roast',
  dark: 'Dark roast',
};

// heatSensitive teas turn bitter mostly from hot water, so the engine lowers
// temperature first; robust teas are corrected through steep time instead.
const TEA_TYPES = {
  green: {
    label: 'Green', temp: [70, 80], heatSensitive: true,
    western: { leaf: [1, 1.5], time: [60, 180] },
    gongfu: { leaf: [4, 5], time: [10, 20], step: 5 },
  },
  white: {
    label: 'White', temp: [80, 90], heatSensitive: true,
    western: { leaf: [1.5, 2.5], time: [180, 300] },
    gongfu: { leaf: [5, 6], time: [20, 30], step: 10 },
  },
  oolong: {
    label: 'Oolong', temp: [85, 95], heatSensitive: false,
    western: { leaf: [1, 1.5], time: [120, 240] },
    gongfu: { leaf: [5, 7], time: [15, 25], step: 5 },
  },
  black: {
    label: 'Black', temp: [90, 100], heatSensitive: false,
    western: { leaf: [1, 1.5], time: [180, 300] },
    gongfu: { leaf: [4, 5], time: [10, 15], step: 5 },
  },
  puerh: {
    label: 'Pu-erh', temp: [95, 100], heatSensitive: false,
    western: { leaf: [1, 1.5], time: [180, 300] },
    gongfu: { leaf: [5, 7], time: [8, 15], step: 5 },
  },
  herbal: {
    label: 'Herbal / tisane', temp: [95, 100], heatSensitive: false,
    western: { leaf: [1.5, 2.5], time: [300, 480] },
    gongfu: null,
  },
};

const TEA_STYLES = {
  western: 'Western (mug or teapot, one long steep)',
  gongfu: 'Gongfu (small pot, many short infusions)',
};

const COFFEE_TASTES = {
  sour: 'Sour / sharp',
  balanced: 'Balanced / sweet',
  bitter: 'Bitter / harsh',
};

const TEA_TASTES = {
  flat: 'Flat / thin',
  balanced: 'Balanced',
  astringent: 'Astringent / drying',
  bitter: 'Bitter',
};

const STRENGTHS = { weak: 'Too weak', good: 'Just right', strong: 'Too strong' };

const mid = ([lo, hi]) => (lo + hi) / 2;
const round = (n, step = 1) => Math.round(n / step) * step;

// Ideal water temperature for a coffee: lighter roasts need hotter water.
function coffeeTargetTemp(method, roast) {
  const [lo, hi] = COFFEE_METHODS[method].temp;
  if (COFFEE_METHODS[method].cold) return 20;
  if (roast === 'light') return hi;
  if (roast === 'dark') return lo;
  return round(mid([lo, hi]));
}

function teaStyle(type, style) {
  const t = TEA_TYPES[type];
  return (style === 'gongfu' && t.gongfu) ? t.gongfu : t.western;
}

// Expected steep time for a given gongfu infusion number (each one is longer).
function teaTimeRange(type, style, infusion = 1) {
  const s = teaStyle(type, style);
  const extra = (s.step || 0) * (infusion - 1);
  return [s.time[0] + extra, s.time[1] + extra];
}

// Starting recipe for a cup of `ml` millilitres.
function recommend({ kind, method, roast, type, style, ml }) {
  if (kind === 'coffee') {
    const p = COFFEE_METHODS[method];
    const water = ml || p.defaultWater;
    const ratio = round(mid(p.ratio), 0.5);
    return {
      method,
      dose_g: round(water / ratio, 0.5),
      water_ml: water,
      ratio,
      temp_c: coffeeTargetTemp(method, roast),
      time_s: round(mid(p.time), method === 'coldbrew' ? 3600 : 5),
      grind: p.grind,
      infusion: 1,
    };
  }
  const t = TEA_TYPES[type];
  const s = teaStyle(type, style);
  const water = ml || (style === 'gongfu' ? 100 : 300);
  return {
    method: style === 'gongfu' && t.gongfu ? 'gongfu' : 'western',
    dose_g: round((water * mid(s.leaf)) / 100, 0.5),
    water_ml: water,
    leaf: mid(s.leaf),
    temp_c: round(mid(t.temp)),
    time_s: round(mid(s.time), 5),
    infusion: 1,
  };
}

module.exports = {
  COFFEE_METHODS, ROAST_LEVELS, TEA_TYPES, TEA_STYLES,
  COFFEE_TASTES, TEA_TASTES, STRENGTHS,
  coffeeTargetTemp, teaStyle, teaTimeRange, recommend, mid, round,
};
