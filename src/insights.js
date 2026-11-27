import { addDays, later, weekday, entry, isDone, isOff, habitAt, streak, recentLevels, mean } from "./lib.js";

export const SHARED_WEEKS = 12;

const perDay = (habit) => habit.type !== "weekly" && habit.type !== "monthly";
// For an avoid habit "done" means a clean day, which would read backwards next to its name.
const correlatable = (habit) => perDay(habit) && habit.type !== "avoid";

// Each day from `from` to `to` the habit was due, with whether it got done. Today counts only once it is done,
// and for weekly and monthly habits done means logged that day. Days whose rules fail `keep` are left out.
export function dueDays(data, habit, from, to, today, keep = () => true) {
  const out = new Map();
  for (let d = later(from, habit.start); d <= to; d = addDays(d, 1)) {
    const rule = habitAt(habit, d);
    if (!keep(rule)) continue;
    const done = isDone(rule, entry(data, habit.id, d));
    if (!done && (isOff(data, habit, d) || (d === today && rule.type !== "avoid"))) continue;
    out.set(d, done);
  }
  return out;
}

const lastDays = (data, habit, today, days, keep) => dueDays(data, habit, addDays(today, -(days - 1)), today, today, keep);

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
  const series = habits.filter(correlatable).map((habit) => ({ habit, days: lastDays(data, habit, today, days, correlatable) }));
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

const moodOn = (data, date) => data.days?.[date]?.mood || null;

// Habits whose done days have a different average mood than their missed days.
export function moodLinks(data, habits, today, { days = 90, minDays = 5, minDiff = 0.3, limit = 5 } = {}) {
  const out = [];
  for (const habit of habits.filter(correlatable)) {
    const done = [];
    const missed = [];
    for (const [date, wasDone] of lastDays(data, habit, today, days, correlatable)) {
      const mood = moodOn(data, date);
      if (mood) (wasDone ? done : missed).push(mood);
    }
    if (done.length < minDays || missed.length < minDays) continue;
    const diff = mean(done) - mean(missed);
    if (Math.abs(diff) >= minDiff) out.push({ habit, done: mean(done), missed: mean(missed), diff });
  }
  return out.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff)).slice(0, limit);
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
