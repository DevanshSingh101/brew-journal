// Small parsing and display helpers shared by the engine, validation and views.

// Accepts "45", "2:30", "1:02:30", "4m", "90s", "16h", "1h30m". Returns seconds or null.
function parseDuration(input) {
  const str = String(input ?? '').trim().toLowerCase();
  if (!str) return null;
  if (/^\d+(\.\d+)?$/.test(str)) return Math.round(Number(str));
  if (/^\d+(:\d{1,2}){1,2}$/.test(str)) {
    return str.split(':').map(Number).reduce((acc, n) => acc * 60 + n, 0);
  }
  const m = str.match(/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in)?)?\s*(?:(\d+)\s*s)?$/);
  if (m && (m[1] || m[2] || m[3])) {
    return Math.round((Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0));
  }
  return null;
}

function formatDuration(totalSeconds) {
  const s = Math.round(totalSeconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

// Value suitable for re-filling the time input ("2:30", "16h").
function durationInput(totalSeconds) {
  const s = Math.round(totalSeconds);
  if (s >= 3600 && s % 3600 === 0) return `${s / 3600}h`;
  if (s >= 60) return formatDuration(s).replace(/ h | min/g, (x) => (x === ' h ' ? 'h' : 'm'));
  return String(s);
}

const num = (n, digits = 1) => String(Number(Number(n).toFixed(digits)));

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

module.exports = { parseDuration, formatDuration, durationInput, num, formatDate };
