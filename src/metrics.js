import { addDays, addMonths, daysBetween, weekStart, entry, periodsOf, lastDay } from "./lib.js";

export const UNITS = ["day", "week", "month", "year", "custom"];
export const COMPARES = ["previous", "lastYear", "average", "best"];
export const AVERAGE_OF = { day: 7, week: 4, month: 3, year: 3, custom: 3 };
export const TREND_PERIODS = 12;

const earlier = (a, b) => (a < b ? a : b);
const leap = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

export function periodAround(unit, date) {
  if (unit === "week") {
    const from = weekStart(date);
    return { from, to: addDays(from, 6) };
  }
  if (unit === "month") {
    const from = `${date.slice(0, 7)}-01`;
    return { from, to: addDays(addMonths(from, 1), -1) };
  }
  if (unit === "year") return { from: `${date.slice(0, 4)}-01-01`, to: `${date.slice(0, 4)}-12-31` };
  return { from: date, to: date };
}

const shift = (unit, date, n) => (unit === "day" ? addDays(date, n) : unit === "week" ? addDays(date, 7 * n) : addMonths(date, (unit === "year" ? 12 : 1) * n));

const withCut = (range, today) => ({ ...range, cut: earlier(range.to, today) });

// A period `back` periods before the one holding today, or for "custom" the range itself. `cut` is the last day
// counted: today, while the period is still running.
export function rangeFor(unit, today, { back = 0, from, to } = {}) {
  if (unit !== "custom") return withCut(periodAround(unit, shift(unit, today, -back)), today);
  const len = daysBetween(from, to) + 1;
  return withCut({ from: addDays(from, -len * back), to: addDays(to, -len * back) }, today);
}

function stepBack(unit, range, n = 1) {
  if (unit !== "custom") return periodAround(unit, shift(unit, range.from, -n));
  const len = daysBetween(range.from, range.to) + 1;
  return { from: addDays(range.from, -len * n), to: addDays(range.to, -len * n) };
}

function yearBefore(unit, range) {
  if (unit === "week") return periodAround("week", addDays(range.from, -364));
  if (unit === "custom") return { from: addMonths(range.from, -12), to: addMonths(range.to, -12) };
  return periodAround(unit, addMonths(range.from, -12));
}

// The day in `other` that matches how far `range` has run: the same date for years, else the same offset from
// the start, at most the end of `other`.
function matchingCut(unit, range, other) {
  if (range.cut >= range.to) return other.to;
  if (unit === "year") {
    const year = +other.from.slice(0, 4);
    const day = range.cut.slice(5);
    return earlier(`${year}-${day === "02-29" && !leap(year) ? "02-28" : day}`, other.to);
  }
  return earlier(addDays(other.from, daysBetween(range.from, range.cut)), other.to);
}

// The ranges `range` is compared with. Like for like, each is cut at the same point `range` has reached;
// otherwise each is counted whole. "best" is found from the data instead, by `bestRange`.
export function comparisonRanges(unit, range, mode, { full = false } = {}) {
  let others;
  if (mode === "lastYear") others = [unit === "year" ? stepBack(unit, range) : yearBefore(unit, range)];
  else if (mode === "average") others = Array.from({ length: AVERAGE_OF[unit] }, (_, i) => stepBack(unit, range, i + 1));
  else others = [stepBack(unit, range)];
  return others.map((other) => ({ ...other, cut: full ? other.to : matchingCut(unit, range, other) }));
}

// For each habit, what each day of its life counted for: `due` marks a day, or the last counted day of a week or
// month, that counts toward the rate, and `done` whether its target was met. The last day of a habit's life counts
// only once done, except for avoid habits. `values` are what was logged.
export function buildFacts(data, habits, today) {
  const out = [];
  for (const habit of habits) {
    const end = lastDay(data, habit, today);
    if (habit.start > end) continue;
    const n = daysBetween(habit.start, end) + 1;
    const fact = {
      habit,
      start: habit.start,
      end,
      due: new Uint8Array(n),
      done: new Uint8Array(n),
      daily: new Uint8Array(n),
      avoid: new Uint8Array(n),
      values: new Float64Array(n),
    };
    for (let i = 0, d = habit.start; i < n; i++, d = addDays(d, 1)) fact.values[i] = entry(data, habit.id, d);
    for (const x of periodsOf(data, habit, habit.start, end)) {
      const daily = x.start === x.end;
      if (!x.met && (x.off || (x.end >= end && (!daily || x.rule.type !== "avoid")))) continue;
      const i = daysBetween(habit.start, earlier(x.end, end));
      if (i < 0) continue;
      fact.due[i] = 1;
      fact.done[i] = x.met ? 1 : 0;
      fact.daily[i] = daily ? 1 : 0;
      if (daily && x.rule.type === "avoid") fact.avoid[i] = 1;
    }
    out.push(fact);
  }
  return out;
}

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

function habitFigures(fact, from, to) {
  const first = Math.max(0, daysBetween(fact.start, from));
  const last = Math.min(fact.due.length - 1, daysBetween(fact.start, to));
  const row = { habit: fact.habit, due: 0, done: 0, total: 0, bestDay: 0, dailyDue: 0, slips: 0, clean: 0, longest: 0, daysLogged: 0 };
  let run = 0;
  for (let i = first; i <= last; i++) {
    const v = fact.values[i];
    if (fact.avoid[i]) {
      if (v) row.slips++;
    } else if (v) {
      row.daysLogged++;
      row.total += v;
      row.bestDay = Math.max(row.bestDay, v);
    }
    if (!fact.due[i]) continue;
    row.due++;
    if (fact.daily[i]) row.dailyDue++;
    if (fact.done[i]) {
      row.done++;
      if (fact.avoid[i]) row.clean++;
      run++;
      row.longest = Math.max(row.longest, run);
    } else run = 0;
  }
  row.rate = row.due ? row.done / row.due : null;
  row.average = row.dailyDue ? row.total / row.dailyDue : null;
  return { row, first, last };
}

// What a range adds up to, from `from` to `cut`. Habits whose life misses the range are left out.
export function measure(data, facts, { from, cut }) {
  const len = daysBetween(from, cut) + 1;
  const dueOn = new Int16Array(Math.max(0, len));
  const doneOn = new Int16Array(Math.max(0, len));
  const activeOn = new Uint8Array(Math.max(0, len));
  const rows = [];
  for (const fact of facts) {
    if (fact.start > cut || fact.end < from) continue;
    const { row, first, last } = habitFigures(fact, from, cut);
    const offset = daysBetween(from, fact.start);
    for (let i = first; i <= last; i++) {
      if (fact.values[i] && !fact.avoid[i]) activeOn[i + offset] = 1;
      if (!fact.due[i] || !fact.daily[i] || fact.avoid[i]) continue;
      dueOn[i + offset]++;
      if (fact.done[i]) doneOn[i + offset]++;
    }
    rows.push(row);
  }
  const sum = (key) => rows.reduce((n, r) => n + r[key], 0);
  let perfectDays = 0;
  let activeDays = 0;
  for (let i = 0; i < len; i++) {
    if (dueOn[i] && doneOn[i] === dueOn[i]) perfectDays++;
    if (activeOn[i]) activeDays++;
  }
  const moods = [];
  const energies = [];
  for (let d = from; d <= cut; d = addDays(d, 1)) {
    const day = data.days?.[d];
    if (day?.mood) moods.push(day.mood);
    if (day?.energy) energies.push(day.energy);
  }
  const due = sum("due");
  const done = sum("done");
  const doneTasks = data.tasks.filter((x) => x.done && x.done >= from && x.done <= cut);
  const dated = doneTasks.filter((x) => x.due);
  const longest = rows.filter((r) => r.habit.type !== "avoid").sort((a, b) => b.longest - a.longest)[0];
  const top = [...rows].sort((a, b) => b.daysLogged - a.daysLogged)[0];
  return {
    from,
    cut,
    rows,
    due,
    done,
    rate: due ? done / due : null,
    perfectDays,
    activeDays,
    checkins: sum("daysLogged"),
    slips: sum("slips"),
    longest: longest?.longest ? { habit: longest.habit, count: longest.longest } : null,
    top: top?.daysLogged ? { habit: top.habit, days: top.daysLogged } : null,
    mood: mean(moods),
    energy: mean(energies),
    tasksDone: doneTasks.length,
    onTime: dated.length ? dated.filter((x) => x.done <= x.due).length / dated.length : null,
    overdue: data.tasks.filter((x) => x.due && x.due < cut && (x.created ?? x.due) <= cut && (!x.done || x.done > cut)).length,
  };
}

export const KPIS = ["rate", "done", "perfectDays", "activeDays", "longest", "slips", "mood", "energy", "tasksDone", "onTime", "overdue"];
export const LOWER_BETTER = new Set(["slips", "overdue"]);

export const kpiValue = (m, key) => (key === "longest" ? m.longest?.count ?? 0 : m[key]);

const meanOf = (values) => mean(values.filter((v) => v != null));

// The mean of several measures, for a comparison with an average; habit rows are matched by habit.
export function averageMeasure(measures) {
  if (measures.length === 1) return measures[0];
  const out = { from: measures.at(-1).from, cut: measures[0].cut, average: true };
  for (const key of KPIS) out[key] = meanOf(measures.map((m) => kpiValue(m, key)));
  out.longest = out.longest == null ? null : { habit: null, count: out.longest };
  const ids = new Map();
  for (const m of measures) for (const r of m.rows) ids.set(r.habit.id, [...(ids.get(r.habit.id) ?? []), r]);
  out.rows = [...ids.values()].map((rows) => {
    const row = { habit: rows[0].habit };
    for (const key of ["due", "done", "total", "slips", "clean", "longest", "rate", "average"]) row[key] = meanOf(rows.map((r) => r[key]));
    return row;
  });
  return out;
}

const firstDay = (facts) => facts.reduce((min, f) => (min && min < f.start ? min : f.start), null);

// Every whole period of `unit` from the first habit's start up to, not including, the one holding `before`.
export function pastRanges(unit, facts, before) {
  const first = firstDay(facts);
  if (!first) return [];
  const out = [];
  for (let r = periodAround(unit, first); r.from < periodAround(unit, before).from; r = periodAround(unit, shift(unit, r.from, 1))) {
    out.push({ ...r, cut: r.to });
  }
  return out;
}

// The past whole period with the highest completion rate, the latest on a tie, or null when none had anything due.
export function bestRange(data, facts, unit, range, pick = (m) => m.rate) {
  let best = null;
  for (const r of pastRanges(unit, facts, range.from)) {
    const m = measure(data, facts, r);
    const v = pick(m);
    if (v != null && (!best || v >= best.value)) best = { range: r, measure: m, value: v };
  }
  return best;
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
export function habitExtremes(data, facts, habitId, unit, before) {
  const fact = facts.find((f) => f.habit.id === habitId);
  if (!fact) return null;
  let best = null;
  let worst = null;
  for (const r of pastRanges(unit, [fact], before)) {
    if (r.to < fact.start || r.from > fact.end) continue;
    const { row } = habitFigures(fact, r.from, r.to);
    if (row.rate == null) continue;
    if (!best || row.rate >= best.rate) best = { ...r, rate: row.rate };
    if (!worst || row.rate <= worst.rate) worst = { ...r, rate: row.rate };
  }
  return best ? { best, worst } : null;
}

// Logged values of a habit on its due days, grouped into `bins` equal steps from 0 to the largest.
export function distribution(facts, habitId, from, to, bins = 6) {
  const fact = facts.find((f) => f.habit.id === habitId);
  if (!fact) return [];
  const values = [];
  for (let i = Math.max(0, daysBetween(fact.start, from)); i <= Math.min(fact.due.length - 1, daysBetween(fact.start, to)); i++) {
    if (fact.daily[i] && fact.due[i] && !fact.avoid[i]) values.push(fact.values[i]);
  }
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

export function metricsCsv(measures, nameOf, label = () => "") {
  const head = ["period", "from", "to", "habit", "due", "done", "rate", "total", "average", "best_day", "slips", "longest_run", "perfect_days", "active_days", "mood", "energy", "tasks_done", "tasks_on_time", "tasks_overdue"];
  const lines = [head];
  for (const m of measures) {
    const at = [label(m), m.from, m.cut];
    lines.push([...at, "", m.due, m.done, m.rate, "", "", "", m.slips, m.longest?.count ?? 0, m.perfectDays, m.activeDays, m.mood, m.energy, m.tasksDone, m.onTime, m.overdue]);
    for (const r of m.rows) lines.push([...at, nameOf(r.habit), r.due, r.done, r.rate, r.total, r.average, r.bestDay, r.slips, r.longest]);
  }
  return lines.map((cells) => cells.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
