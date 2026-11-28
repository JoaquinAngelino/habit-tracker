import { addDays, addMonths, daysBetween, dayNumber, earlier, later, mean, isAmount, periodsOf, countsTowardRate, lastDay, lifeStart, habitAt, PERIODS, MIN_DATE } from "./lib.js";

export const UNITS = ["day", "week", "month", "year", "custom"];
const COMPARES = ["previous", "lastYear", "average", "best"];
export const AVERAGE_OF = { day: 7, week: 4, month: 3, year: 3, custom: 3 };
const TREND_PERIODS = 12;

// A year before a year is the previous one; a custom range has no calendar periods to pick a best from.
export const comparesFor = (unit) => COMPARES.filter((m) => !(m === "best" && unit === "custom") && !(m === "lastYear" && unit === "year"));

export function periodAround(unit, date) {
  const p = PERIODS[unit];
  const from = p.start(date);
  return { from, to: unit === "day" ? from : addDays(p.next(from), -1) };
}

const shift = (unit, date, n) => (unit === "day" ? addDays(date, n) : unit === "week" ? addDays(date, 7 * n) : addMonths(date, (unit === "year" ? 12 : 1) * n));

function stepBack(unit, range, n = 1) {
  if (unit !== "custom") return periodAround(unit, shift(unit, range.from, -n));
  const len = daysBetween(range.from, range.to) + 1;
  return { from: addDays(range.from, -len * n), to: addDays(range.to, -len * n) };
}

const withCut = (range, today) => ({ ...range, cut: earlier(range.to, today) });

// `cut` is the last day counted: today, while the period is still running.
export const rangeFor = (unit, today, { back = 0, from, to } = {}) =>
  withCut(stepBack(unit, unit === "custom" ? { from, to } : periodAround(unit, today), back), today);

function yearBefore(unit, range) {
  if (unit === "week") return periodAround("week", addDays(range.from, -364));
  if (unit === "custom") return { from: addMonths(range.from, -12), to: addMonths(range.to, -12) };
  return periodAround(unit, addMonths(range.from, -12));
}

// The day in `other` as far in as `range` has run: the same date for years, else the same offset.
function matchingCut(unit, range, other) {
  if (range.cut >= range.to) return other.to;
  if (unit === "year") return earlier(addMonths(range.cut, 12 * (+other.from.slice(0, 4) - +range.from.slice(0, 4))), other.to);
  return earlier(addDays(other.from, daysBetween(range.from, range.cut)), other.to);
}

// Like for like, each is cut where `range` has reached; with `full`, each counts whole.
export function comparisonRanges(unit, range, mode, { full = false } = {}) {
  let others;
  if (mode === "lastYear") others = [yearBefore(unit, range)];
  else if (mode === "average") others = Array.from({ length: AVERAGE_OF[unit] }, (_, i) => stepBack(unit, range, i + 1));
  else others = [stepBack(unit, range)];
  return others.map((other) => ({ ...other, cut: full ? other.to : matchingCut(unit, range, other) }));
}

// A week or month counts on the day its target was met, else its last day, so cut ranges compare the same periods.
// A day still open today and not done yet is `pending`.
export function habitFacts(data, habit, today) {
  const start = lifeStart(habit);
  const end = lastDay(data, habit, today);
  if (start > end) return null;
  const n = daysBetween(start, end) + 1;
  const fact = {
    habit,
    start,
    startN: dayNumber(start),
    end,
    due: new Uint8Array(n),
    done: new Uint8Array(n),
    avoid: new Uint8Array(n),
    pending: new Uint8Array(n),
    run: new Uint32Array(n),
    periodDue: new Uint8Array(n),
    periodDone: new Uint8Array(n),
    values: new Float64Array(n),
    cumDue: new Int32Array(n + 1),
    cumDone: new Int32Array(n + 1),
  };
  for (const [date, day] of Object.entries(data.log)) {
    const v = Number(day[habit.id]);
    if (v > 0 && Number.isFinite(v) && date >= start && date <= end) fact.values[daysBetween(start, date)] = v;
  }
  for (const x of periodsOf(data, habit, start, end)) {
    const counts = countsTowardRate(x, today);
    if (x.unit !== "day") {
      if (!counts) continue;
      const i = Math.max(0, daysBetween(start, earlier(x.on, end)));
      fact.periodDue[i]++;
      if (x.met) fact.periodDone[i]++;
      continue;
    }
    const i = daysBetween(start, x.start);
    fact.avoid[i] = x.rule.type === "avoid" ? 1 : 0;
    fact.run[i] = x.run;
    if (counts) {
      fact.due[i] = 1;
      fact.done[i] = x.met ? 1 : 0;
    } else if (!x.off && x.end >= today) fact.pending[i] = 1;
  }
  for (let i = 0; i < n; i++) {
    fact.cumDue[i + 1] = fact.cumDue[i] + fact.due[i] + fact.periodDue[i];
    fact.cumDone[i + 1] = fact.cumDone[i] + fact.done[i] + fact.periodDone[i];
  }
  return fact;
}

// Day numbers instead of dates, so scanning many ranges parses no strings.
function span(fact, fromN, toN) {
  const first = Math.max(0, fromN - fact.startN);
  const last = Math.min(fact.due.length - 1, toN - fact.startN);
  const empty = last < first;
  return { first, last, due: empty ? 0 : fact.cumDue[last + 1] - fact.cumDue[first], done: empty ? 0 : fact.cumDone[last + 1] - fact.cumDone[first] };
}

const spanOf = (fact, from, to) => span(fact, dayNumber(from), dayNumber(to));

// Runs count days only and restart where the habit's type changed.
function habitFigures(fact, from, to) {
  const { first, last } = spanOf(fact, from, to);
  const row = { habit: fact.habit, rule: habitAt(fact.habit, earlier(to, fact.end)), due: 0, done: 0, total: 0, dueTotal: 0, bestDay: 0, dailyDue: 0, slips: 0, clean: 0, longest: 0, longestClean: 0, daysLogged: 0 };
  let count = 0;
  let clean = 0;
  let run = -1;
  for (let i = first; i <= last; i++) {
    const v = fact.values[i];
    if (fact.avoid[i]) {
      if (v) row.slips++;
    } else if (v) {
      row.daysLogged++;
      row.total += v;
      row.bestDay = Math.max(row.bestDay, v);
    }
    row.due += fact.periodDue[i];
    row.done += fact.periodDone[i];
    if (!fact.due[i]) continue;
    row.due++;
    if (fact.done[i]) row.done++;
    if (fact.run[i] !== run) count = clean = 0;
    run = fact.run[i];
    if (fact.avoid[i]) {
      clean = fact.done[i] ? clean + 1 : 0;
      row.clean += fact.done[i];
      row.longestClean = Math.max(row.longestClean, clean);
      continue;
    }
    row.dailyDue++;
    row.dueTotal += v;
    count = fact.done[i] ? count + 1 : 0;
    row.longest = Math.max(row.longest, count);
  }
  row.rate = row.due ? row.done / row.due : null;
  row.average = row.dailyDue ? row.dueTotal / row.dailyDue : null;
  return { row, first, last };
}

// A day is perfect when every habit due, avoid habits included, was done and nothing is still pending.
export function measure(data, facts, range) {
  const { cut } = range;
  const from = later(range.from, MIN_DATE);
  const len = Math.max(0, daysBetween(from, cut) + 1);
  const dueOn = new Int16Array(len);
  const doneOn = new Int16Array(len);
  const pendingOn = new Uint8Array(len);
  const activeOn = new Uint8Array(len);
  const rows = [];
  let pending = 0;
  for (const fact of facts) {
    if (fact.start > cut || fact.end < from) continue;
    const { row, first, last } = habitFigures(fact, from, cut);
    const offset = daysBetween(from, fact.start);
    for (let i = first; i <= last; i++) {
      if (fact.values[i] && !fact.avoid[i]) activeOn[i + offset] = 1;
      if (fact.pending[i]) {
        pendingOn[i + offset] = 1;
        pending++;
      }
      if (!fact.due[i]) continue;
      dueOn[i + offset]++;
      if (fact.done[i]) doneOn[i + offset]++;
    }
    rows.push(row);
  }
  const sum = (key) => rows.reduce((n, r) => n + r[key], 0);
  let perfectDays = 0;
  let activeDays = 0;
  for (let i = 0; i < len; i++) {
    if (dueOn[i] && doneOn[i] === dueOn[i] && !pendingOn[i]) perfectDays++;
    if (activeOn[i]) activeDays++;
  }
  const moods = [];
  const energies = [];
  for (const [date, day] of Object.entries(data.days ?? {})) {
    if (date < from || date > cut) continue;
    if (day?.mood) moods.push(day.mood);
    if (day?.energy) energies.push(day.energy);
  }
  const due = sum("due");
  const done = sum("done");
  const doneTasks = data.tasks.filter((x) => x.done && x.done >= from && x.done <= cut);
  const dated = doneTasks.filter((x) => x.due);
  const best = (key) => {
    const row = rows.reduce((a, b) => (b[key] > (a?.[key] ?? 0) ? b : a), null);
    return row ? { habit: row.habit, count: row[key] } : null;
  };
  return {
    from,
    cut,
    rows,
    due,
    done,
    rate: due ? done / due : null,
    pending,
    perfectDays,
    activeDays,
    checkins: sum("daysLogged"),
    slips: sum("slips"),
    clean: sum("clean"),
    longest: best("longest"),
    longestClean: best("longestClean"),
    top: best("daysLogged"),
    mood: mean(moods),
    energy: mean(energies),
    tasksDone: doneTasks.length,
    onTime: dated.length ? dated.filter((x) => x.done <= x.due).length / dated.length : null,
    overdue: data.tasks.filter((x) => x.due && x.due < cut && (x.created ?? x.due) <= cut && (!x.done || x.done > cut)).length,
  };
}

export const KPIS = ["rate", "done", "checkins", "perfectDays", "activeDays", "longest", "slips", "longestClean", "mood", "energy", "tasksDone", "onTime", "overdue"];
// These cover every habit whatever group is picked.
export const GLOBAL_KPIS = new Set(["mood", "energy", "tasksDone", "onTime", "overdue"]);
export const LOWER_BETTER = new Set(["slips", "overdue"]);

// Figures counted in days, kept with the habit they belong to.
export const RUN_KPIS = new Set(["longest", "longestClean"]);

export const kpiValue = (m, key) => (RUN_KPIS.has(key) ? m[key]?.count ?? 0 : m[key]);

const meanOf = (values) => mean(values.filter((v) => v != null));

export function averageMeasure(measures) {
  if (measures.length === 1) return measures[0];
  const out = { from: measures.at(-1).from, cut: measures[0].cut, average: true };
  for (const key of [...KPIS, "due"]) out[key] = meanOf(measures.map((m) => kpiValue(m, key)));
  out.clean = meanOf(measures.map((m) => m.clean));
  for (const key of RUN_KPIS) out[key] = out[key] == null ? null : { habit: null, count: out[key] };
  const ids = new Map();
  for (const m of measures) for (const r of m.rows) ids.set(r.habit.id, [...(ids.get(r.habit.id) ?? []), r]);
  out.rows = [...ids.values()].map((rows) => {
    const row = { habit: rows[0].habit, rule: rows[0].rule };
    for (const key of ["due", "done", "total", "slips", "clean", "longest", "longestClean", "rate", "average", "bestDay", "daysLogged"]) row[key] = meanOf(rows.map((r) => r[key]));
    return row;
  });
  return out;
}

// Ranges that some habit's life reaches; with `keepLast`, the last one stays either way.
export const rangesWithData = (facts, ranges, { keepLast = false } = {}) =>
  ranges.filter((r, i) => (keepLast && i === ranges.length - 1) || facts.some((f) => f.start <= r.cut && f.end >= r.from));

// Every whole period of `unit` from the first habit's start up to, not including, the one holding `before`.
export function pastRanges(unit, facts, before) {
  const first = facts.reduce((min, f) => (min && min < f.start ? min : f.start), null);
  if (!first) return [];
  const stop = periodAround(unit, before).from;
  const out = [];
  for (let r = periodAround(unit, first); r.from < stop; r = periodAround(unit, PERIODS[unit].next(r.from))) out.push({ ...r, cut: r.to });
  return out;
}

function rateOver(facts, r) {
  const fromN = dayNumber(r.from);
  const toN = dayNumber(r.to);
  let due = 0;
  let done = 0;
  for (const f of facts) {
    const s = span(f, fromN, toN);
    due += s.due;
    done += s.done;
  }
  return due ? done / due : null;
}

// The past period with the best rate, the latest on a tie, cut like `range` unless `full`.
export function bestRange(data, facts, unit, range, { full = false } = {}) {
  let best = null;
  for (const r of pastRanges(unit, facts, range.from)) {
    const value = rateOver(facts, r);
    if (value != null && (!best || value >= best.value)) best = { whole: r, value };
  }
  if (!best) return null;
  const cut = { ...best.whole, cut: full ? best.whole.to : matchingCut(unit, range, best.whole) };
  return { ...best, range: cut, measure: measure(data, facts, cut) };
}

export function compare(data, facts, unit, range, mode, { full = false } = {}) {
  if (mode === "best") {
    const best = unit === "custom" ? null : bestRange(data, facts, unit, range, { full });
    return best ? { before: best.measure, ranges: [best.range] } : { before: null, ranges: [] };
  }
  const ranges = rangesWithData(facts, comparisonRanges(unit, range, mode, { full }));
  return { before: ranges.length ? averageMeasure(ranges.map((r) => measure(data, facts, r))) : null, ranges };
}

// The last `count` ranges up to `range`, oldest first; the earlier ones whole.
export function trendRanges(unit, range, count = TREND_PERIODS) {
  return Array.from({ length: count }, (_, i) => {
    const back = count - 1 - i;
    if (!back) return range;
    const r = stepBack(unit, range, back);
    return { ...r, cut: r.to };
  });
}

export const yearEarlier = (unit, ranges) => ranges.map((r) => {
  const other = yearBefore(unit, r);
  return { ...other, cut: matchingCut(unit, r, other) };
});

// A habit's best and worst whole periods with anything due, the latest on a tie.
export function habitExtremes(fact, unit, before) {
  let best = null;
  let worst = null;
  for (const r of pastRanges(unit, [fact], before)) {
    const rate = rateOver([fact], r);
    if (rate == null) continue;
    if (!best || rate >= best.rate) best = { ...r, rate };
    if (!worst || rate <= worst.rate) worst = { ...r, rate };
  }
  return best ? { best, worst } : null;
}

// Each amount habit's total in a measure.
export const amountTotals = (m) => m.rows.filter((r) => isAmount(r.rule) && r.total).map((r) => ({ habit: r.habit, rule: r.rule, total: r.total }));

// Values logged on a habit's due days, grouped into `bins` equal steps from 0 to the largest.
export function distribution(fact, from, to, bins = 6) {
  const values = [];
  const { first, last } = spanOf(fact, from, to);
  for (let i = first; i <= last; i++) if (fact.due[i] && !fact.avoid[i]) values.push(fact.values[i]);
  const max = Math.max(0, ...values);
  if (!values.length || !max) return [];
  const step = max / bins;
  const out = Array.from({ length: bins }, (_, i) => ({ from: i * step, to: (i + 1) * step, count: 0 }));
  for (const v of values) out[Math.min(bins - 1, Math.floor(v / step))].count++;
  return out;
}

// Spreadsheet apps run a cell that starts with one of these as a formula.
const FORMULA = /^[=+\-@\t\r]/;

function csvCell(value) {
  if (value == null) return "";
  let text = typeof value === "number" ? String(Math.round(value * 1000) / 1000) : String(value);
  if (FORMULA.test(text) && typeof value !== "number") text = `'${text}`;
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// With `global` off, the figures that belong to no habit group are left blank.
export function metricsCsv(measures, nameOf, label = () => "", { global = true } = {}) {
  const head = ["period", "from", "to", "habit", "due", "done", "rate", "total", "average", "best_day", "slips", "clean_days", "longest_run", "longest_clean_run", "checkins", "perfect_days", "active_days", "mood", "energy", "tasks_done", "tasks_on_time", "tasks_overdue"];
  const lines = [head];
  for (const m of measures) {
    const at = [label(m), m.from, m.cut];
    const shared = global ? [m.mood, m.energy, m.tasksDone, m.onTime, m.overdue] : [];
    lines.push([...at, "", m.due, m.done, m.rate, "", "", "", m.slips, m.clean, m.longest?.count ?? 0, m.longestClean?.count ?? 0, m.checkins, m.perfectDays, m.activeDays, ...shared]);
    for (const r of m.rows) lines.push([...at, nameOf(r.habit), r.due, r.done, r.rate, r.total, r.average, r.bestDay, r.slips, r.clean, r.longest, r.longestClean, r.daysLogged]);
  }
  return lines.map((cells) => cells.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
