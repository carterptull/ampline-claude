'use strict';
const cache = require('./cache');

const USAGE_KEY = 'usage';
const MAX_STALE_MS = 24 * 60 * 60 * 1000;

const MAX_FUTURE_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

// resets_at is epoch SECONDS (confirmed 10-digit in practice). One conversion
// path for every caller — a bare `new Date(seconds)` reads as 1970 and pins
// the countdown at 0m.
function toMs(value) {
  if (value == null) return null;

  if (typeof value === 'number' || /^\s*\d+(\.\d+)?\s*$/.test(String(value))) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return null;
    // A value already this large (>1e11) can only be milliseconds, not
    // seconds — multiplying it again would stay wedged in the cache forever.
    const ms = num > 1e11 ? num : num * 1000;
    if (Number.isNaN(new Date(ms).getTime())) return null;
    // No real rate-limit window resets more than ~60 days out.
    if (ms - Date.now() > MAX_FUTURE_MS) return null;
    return ms;
  }

  const parsed = new Date(String(value)).getTime();
  if (Number.isNaN(parsed)) return null;
  return parsed - Date.now() > MAX_FUTURE_MS ? null : parsed;
}

// Clamp but don't round — rounding here would lose 0.4 vs 0 in the bar fill.
function toEntry(segment) {
  if (!segment || typeof segment !== 'object') return null;
  const pct = Number(segment.used_percentage);
  if (!Number.isFinite(pct)) return null;
  return {
    percentage: Math.max(0, Math.min(100, pct)),
    resetsAtMs: toMs(segment.resets_at),
  };
}

// five_hour and seven_day are independently absent.
function fromStdin(input) {
  const rl = input && input.rate_limits;
  if (!rl || typeof rl !== 'object') return null;
  const fiveHour = toEntry(rl.five_hour);
  const weekly = toEntry(rl.seven_day);
  if (!fiveHour && !weekly) return null;
  return { fiveHour, weekly };
}

// A cached window past its reset time has rolled over — its percentage is
// wrong, not just old. Drop it rather than show it as current.
function keepIfCurrent(entry, now) {
  if (!entry || typeof entry !== 'object') return null;
  if (!Number.isFinite(entry.percentage)) return null;
  if (entry.resetsAtMs != null && entry.resetsAtMs <= now) return null;
  return { percentage: entry.percentage, resetsAtMs: entry.resetsAtMs ?? null };
}

// stdin -> write-through cache -> live. Absent -> cache, dropping any rolled-
// over window, marked stale. Neither -> null.
function resolveUsage(input) {
  const live = fromStdin(input);
  if (live) {
    cache.write(USAGE_KEY, { fiveHour: live.fiveHour, weekly: live.weekly });
    return { fiveHour: live.fiveHour, weekly: live.weekly, stale: false };
  }

  const cached = cache.read(USAGE_KEY);
  if (!cached || !cached.value || typeof cached.value !== 'object') return null;
  if (cached.age > MAX_STALE_MS) return null;

  const now = Date.now();
  const fiveHour = keepIfCurrent(cached.value.fiveHour, now);
  const weekly = keepIfCurrent(cached.value.weekly, now);
  if (!fiveHour && !weekly) return null;

  return { fiveHour, weekly, stale: true };
}

// "2h13m" / "3d4h" / "12m". Empty when unknown or already past.
function formatCountdown(resetsAtMs) {
  if (!Number.isFinite(resetsAtMs)) return '';
  const mins = Math.floor((resetsAtMs - Date.now()) / 60000);
  if (mins <= 0) return '';
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${m}m`;
  return `${m}m`;
}

module.exports = { resolveUsage, formatCountdown, toMs };
