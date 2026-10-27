// Estimating water temperature without a thermometer.
// Bubble stages follow the traditional Chinese tea descriptions ("shrimp eyes",
// "crab eyes", ...). They are approximate and assume sea level: water boils
// about 1 °C lower for every 300 m of altitude.

const STAGES = [
  {
    key: 'steam', name: 'Wisps of steam', range: [60, 70], est: 65,
    look: 'Steam drifts off the surface. Tiny bubbles cling to the bottom but do not rise.',
    bubbles: { r: 0.9, n: 9, band: [76, 79] },
  },
  {
    key: 'shrimp', name: 'Shrimp eyes', range: [70, 80], est: 75,
    look: 'Pin-head bubbles, about 2–3 mm, start rising from the bottom. A faint hiss.',
    bubbles: { r: 1.3, n: 16, band: [45, 78] },
  },
  {
    key: 'crab', name: 'Crab eyes', range: [80, 85], est: 83,
    look: 'Bubbles about 5 mm rise in loose streams. Steady steam.',
    bubbles: { r: 2.6, n: 11, band: [42, 77] },
  },
  {
    key: 'fish', name: 'Fish eyes', range: [85, 90], est: 88,
    look: 'Bubbles about 8 mm. The surface begins to shimmer and move.',
    bubbles: { r: 4, n: 8, band: [42, 75] },
  },
  {
    key: 'pearls', name: 'String of pearls', range: [90, 96], est: 93,
    look: 'Continuous chains of bubbles rise from the bottom. The kettle rumbles loudly.',
    bubbles: { r: 2.1, chains: 4 },
  },
  {
    key: 'boil', name: 'Rolling boil', range: [96, 100], est: 100,
    look: 'Large bubbles break the surface everywhere. The rumble quietens.',
    bubbles: { r: 5, n: 9, band: [40, 74] },
  },
];

const COLD = { key: 'cold', name: 'Cold / room temperature', range: [0, 30], est: 20 };

function stageByKey(key) {
  return STAGES.find((s) => s.key === key) || (key === COLD.key ? COLD : null);
}

function stageFor(tempC) {
  if (tempC <= COLD.range[1]) return COLD;
  return STAGES.find((s) => tempC >= s.range[0] && tempC <= s.range[1]) || null;
}

// Rough minutes a just-boiled kettle (~500 ml, lid open) needs to cool to a temperature.
const REST_MINUTES = [[100, 0], [95, 1], [90, 2.5], [85, 4], [80, 6], [75, 8], [70, 11], [65, 14]];

function restMinutes(tempC) {
  if (tempC >= 100) return 0;
  for (let i = 1; i < REST_MINUTES.length; i++) {
    const [hiT, hiM] = REST_MINUTES[i - 1];
    const [loT, loM] = REST_MINUTES[i];
    if (tempC >= loT) return Math.round((hiM + ((hiT - tempC) / (hiT - loT)) * (loM - hiM)) * 2) / 2;
  }
  return null; // colder than the table: use the mixing method
}

// Mixing boiling and cold water is the most reliable no-thermometer method.
// Energy balance: hot * (100 - T) = cold * (T - tap)  →  hot fraction = (T - tap) / (100 - tap).
function mixFor(tempC, totalMl, tapC = 20) {
  if (tempC >= 100 || tempC <= tapC) return null;
  const hot = Math.round(((tempC - tapC) / (100 - tapC)) * totalMl / 5) * 5;
  return { hot, cold: Math.max(0, Math.round(totalMl) - hot), tapC };
}

// Everything a user needs to hit `tempC` without a thermometer.
function howToReach(tempC, totalMl) {
  return { temp: tempC, stage: stageFor(tempC), rest: restMinutes(tempC), mix: mixFor(tempC, totalMl || 250) };
}

// Minimal line drawing of a pot at a given stage, coloured by `currentColor`.
function stageSvg(stage) {
  let seed = stage.key.length * 9301 + stage.range[0];
  const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const parts = [];
  const b = stage.bubbles;
  if (b.chains) {
    for (let c = 0; c < b.chains; c++) {
      const x = 30 + c * 20 + rand() * 6;
      for (let y = 76; y > 40; y -= 6) parts.push(`<circle cx="${(x + rand() * 2).toFixed(1)}" cy="${y}" r="${b.r}"/>`);
    }
  } else {
    for (let i = 0; i < b.n; i++) {
      const x = 22 + rand() * 76;
      const y = b.band[0] + rand() * (b.band[1] - b.band[0]);
      parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${b.r}"/>`);
    }
  }
  const surface = stage.key === 'boil'
    ? 'M15 36 q7 -5 15 0 t15 0 t15 0 t15 0 t15 0 t15 0'
    : stage.key === 'fish' || stage.key === 'pearls'
      ? 'M15 36 q7 -2 15 0 t15 0 t15 0 t15 0 t15 0 t15 0'
      : 'M15 36 H105';
  const steamCount = { steam: 2, shrimp: 2, crab: 3, fish: 3, pearls: 4, boil: 5 }[stage.key];
  const steam = [];
  for (let i = 0; i < steamCount; i++) {
    const x = 30 + i * (60 / Math.max(1, steamCount - 1));
    steam.push(`<path d="M${x.toFixed(0)} 28 q-4 -5 0 -10 t0 -10" opacity=".45"/>`);
  }
  return `<svg viewBox="0 0 120 90" width="120" height="90" role="img" aria-label="${stage.name}" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">`
    + `${steam.join('')}<path d="M15 20 V82 H105 V20"/><path d="${surface}" opacity=".6"/>${parts.join('')}</svg>`;
}

module.exports = { STAGES, COLD, stageByKey, stageFor, restMinutes, mixFor, howToReach, stageSvg };
