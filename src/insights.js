import { addDays, later, weekday, entry, isDone, isAmount, isOff, periodCount, streak, recentLevels, everyFrom } from "./lib.js";

export const SHARED_WEEKS = 12;

const perDay = (habit) => habit.type !== "weekly" && habit.type !== "monthly";
// For an avoid habit "done" means a clean day, which would read backwards next to its name.
const correlatable = (habit) => perDay(habit) && habit.type !== "avoid";

// Each day from `from` to `to` the habit was due, with whether it got done. Today counts only once it is done,
// and for weekly and monthly habits done means logged that day.
export function dueDays(data, habit, from, to, today) {
  const out = new Map();
  for (let d = later(from, habit.start); d <= to; d = addDays(d, 1)) {
    const done = isDone(habit, entry(data, habit.id, d));
    if (!done && (isOff(data, habit, d) || (d === today && habit.type !== "avoid"))) continue;
    out.set(d, done);
  }
  return out;
}

const lastDays = (data, habit, today, days) => dueDays(data, habit, addDays(today, -(days - 1)), today, today);

// Share of each weekday, Monday first, on which the habit got done; null for a weekday it was never due.
export function weekdayPattern(data, habit, today, days = 90) {
  const slots = Array.from({ length: 7 }, () => ({ done: 0, due: 0 }));
  for (const [date, done] of lastDays(data, habit, today, days)) {
    const slot = slots[weekday(date)];
    slot.due++;
    if (done) slot.done++;
  }
  return slots.map((s) => (s.due ? s.done / s.due : null));
}

// Pairs of habits that tend to get done, or missed, on the same days. `withA` and `withoutA` are how often
// b got done on days a was done and on days it was not.
export function correlations(data, habits, today, { days = 90, minDays = 14, minPhi = 0.3, limit = 5 } = {}) {
  const series = habits.filter(correlatable).map((habit) => ({ habit, days: lastDays(data, habit, today, days) }));
  const out = [];
  for (let i = 0; i < series.length; i++) {
    for (let j = i + 1; j < series.length; j++) {
      let both = 0;
      let onlyA = 0;
      let onlyB = 0;
      let neither = 0;
      for (const [date, a] of series[i].days) {
        const b = series[j].days.get(date);
        if (b == null) continue;
        if (a && b) both++;
        else if (a) onlyA++;
        else if (b) onlyB++;
        else neither++;
      }
      const n = both + onlyA + onlyB + neither;
      const spread = (both + onlyA) * (onlyB + neither) * (both + onlyB) * (onlyA + neither);
      if (n < minDays || !spread) continue;
      const phi = (both * neither - onlyA * onlyB) / Math.sqrt(spread);
      if (Math.abs(phi) < minPhi) continue;
      out.push({ a: series[i].habit, b: series[j].habit, phi, n, withA: both / (both + onlyA), withoutA: onlyB / (onlyB + neither) });
    }
  }
  return out.sort((x, y) => Math.abs(y.phi) - Math.abs(x.phi)).slice(0, limit);
}

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const moodOn = (data, date) => data.days?.[date]?.mood || null;

// Habits whose done days have a different average mood than their missed days.
export function moodLinks(data, habits, today, { days = 90, minDays = 5, minDiff = 0.3, limit = 5 } = {}) {
  const out = [];
  for (const habit of habits.filter(correlatable)) {
    const done = [];
    const missed = [];
    for (const [date, wasDone] of lastDays(data, habit, today, days)) {
      const mood = moodOn(data, date);
      if (mood) (wasDone ? done : missed).push(mood);
    }
    if (done.length < minDays || missed.length < minDays) continue;
    const diff = mean(done) - mean(missed);
    if (Math.abs(diff) >= minDiff) out.push({ habit, done: mean(done), missed: mean(missed), diff });
  }
  return out.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff)).slice(0, limit);
}

function moodBetween(data, from, to) {
  const moods = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (moodOn(data, d)) moods.push(moodOn(data, d));
  return mean(moods);
}

const tasksDoneBetween = (data, from, to) => data.tasks.filter((x) => x.done && x.done >= from && x.done <= to).length;

// One week, from its Monday: what was due and done per habit. Monthly habits are left out.
export function weekReview(data, habits, start, today) {
  const end = addDays(start, 6) < today ? addDays(start, 6) : today;
  const rows = [];
  for (const habit of habits) {
    if (habit.type === "monthly" || habit.start > end) continue;
    if (habit.type === "weekly") {
      const target = habit.target || 1;
      rows.push({ habit, done: Math.min(target, periodCount(data, habit, start)), due: target });
      continue;
    }
    const days = [...dueDays(data, habit, start, end, today).values()];
    if (days.length) rows.push({ habit, done: days.filter(Boolean).length, due: days.length });
  }
  const done = rows.reduce((n, r) => n + r.done, 0);
  const due = rows.reduce((n, r) => n + r.due, 0);
  return { start, end, rows, done, due, rate: due ? done / due : null, tasksDone: tasksDoneBetween(data, start, end), mood: moodBetween(data, start, end) };
}

// A calendar year so far. Slips on avoid habits are counted apart from check-ins.
export function yearRecap(data, habits, year, today) {
  const from = `${year}-01-01`;
  const to = `${year}-12-31` < today ? `${year}-12-31` : today;
  const byId = new Map(habits.map((h) => [h.id, h]));
  const daysLogged = new Map();
  const totals = new Map();
  let checkins = 0;
  let slips = 0;
  let activeDays = 0;
  for (const [date, day] of Object.entries(data.log)) {
    if (date < from || date > to) continue;
    let active = false;
    for (const [id, value] of Object.entries(day)) {
      const habit = byId.get(id);
      if (!habit || !value) continue;
      if (habit.type === "avoid") {
        slips++;
        continue;
      }
      active = true;
      checkins++;
      daysLogged.set(id, (daysLogged.get(id) ?? 0) + 1);
      totals.set(id, (totals.get(id) ?? 0) + value);
    }
    if (active) activeDays++;
  }
  const [topId, topDays] = [...daysLogged].sort((a, b) => b[1] - a[1])[0] ?? [];
  let best = null;
  for (const habit of habits) {
    if (habit.start > to) continue;
    // The streak is walked from the start of the year, with every-N days still counted from where they were.
    const inYear = { ...habit, start: later(habit.start, from), everyFrom: everyFrom(habit) };
    const s = streak(data, inYear, to);
    if (s.best && (!best || s.best > best.count) && s.unit === "day") best = { habit, count: s.best };
  }
  return {
    year,
    checkins,
    slips,
    activeDays,
    top: topId ? { habit: byId.get(topId), days: topDays } : null,
    streak: best,
    totals: habits.filter((h) => isAmount(h) && totals.get(h.id)).map((habit) => ({ habit, total: totals.get(habit.id) })),
    tasksDone: tasksDoneBetween(data, from, to),
    mood: moodBetween(data, from, to),
  };
}

// What a share link shows: a name, and each habit's name, streak, 30-day rate and recent days. No notes, amounts or tasks.
export function sharedProgress(data, habits, today, name, rateOf) {
  return {
    v: 1,
    name,
    updated: today,
    habits: habits.map((habit) => ({
      name: habit.name,
      avoid: habit.type === "avoid",
      streak: streak(data, habit, today),
      rate: rateOf(habit),
      cells: recentLevels(data, habit, today, SHARED_WEEKS),
    })),
  };
}
