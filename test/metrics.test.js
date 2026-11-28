import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyData, streak, rate, isOff, level, goalProgress, habitAt, withRules, rulesSince, changesRules, asksRuleChoice, lastDay, recentLevels, restoreOps, archiveOps } from "../src/lib.js";
import { correlations } from "../src/insights.js";
import { toIcs } from "../src/ics.js";
import { habitFacts, measure, rangeFor, comparisonRanges, compare, averageMeasure, bestRange, trendRanges, yearEarlier, habitExtremes, distribution, metricsCsv, periodAround, comparesFor, amountTotals } from "../src/metrics.js";

const TODAY = "2026-11-24"; // a Tuesday
const daily = { id: "h", name: "Read", type: "check", target: 1, unit: "", start: "2026-11-01" };

function dataWith(habits, log = {}) {
  const data = emptyData();
  data.habits.push(...[].concat(habits));
  for (const [date, day] of Object.entries(log)) data.log[date] = { ...day };
  return data;
}

const days = (from, to, value = 1) => {
  const out = {};
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) out[d.toISOString().slice(0, 10)] = value;
  return out;
};
const logOf = (id, dates) => Object.fromEntries(Object.entries(dates).map(([date, v]) => [date, { [id]: v }]));
const buildFacts = (data, habits, today) => habits.map((h) => habitFacts(data, h, today)).filter(Boolean);
const measureOf = (data, habits, from, cut, today = TODAY) => measure(data, buildFacts(data, habits, today), { from, cut });

test("raising a target from today keeps past days done under the old target", () => {
  const water = { ...daily, type: "amount", target: 8, unit: "glasses" };
  const data = dataWith(water, logOf("h", days("2026-11-01", "2026-11-23", 5)));
  const raised = withRules(water, { target: 10 }, TODAY, "today");
  assert.deepEqual(raised.past, [{ until: "2026-11-23", type: "amount", target: 8, days: [], every: 0, everyFrom: "2026-11-01" }]);
  assert.equal(level(data, raised, "2026-11-20", TODAY), 3);
  data.log[TODAY] = { h: 5 };
  assert.equal(level(data, raised, TODAY, TODAY), 2);
  assert.equal(rulesSince(raised), TODAY);
});

test("rewriting the rules reaches back to when they began, or to the habit's start", () => {
  const water = { ...daily, type: "amount", target: 8 };
  const data = dataWith(water, logOf("h", days("2026-11-01", "2026-11-23", 8)));
  assert.equal(rate(data, withRules(water, { target: 10 }, TODAY, "current"), TODAY, 7), 0);
  const twice = withRules(withRules(water, { target: 9 }, "2026-11-10", "today"), { target: 10 }, TODAY, "current");
  assert.equal(habitAt(twice, "2026-11-05").target, 8);
  assert.equal(habitAt(twice, "2026-11-15").target, 10);
  assert.equal(withRules(twice, { target: 12 }, TODAY, "all").past, undefined);
});

test("several edits on one day make one era, and a habit started today never gets one", () => {
  const once = withRules({ ...daily, type: "amount", target: 8 }, { target: 9 }, TODAY, "today");
  const twice = withRules(once, { target: 10 }, TODAY, "today");
  assert.deepEqual([twice.past.length, twice.past[0].target, twice.target], [1, 8, 10]);
  assert.equal(asksRuleChoice(once, { target: 11 }, TODAY), false);
  assert.equal(asksRuleChoice({ ...daily, start: TODAY }, { days: [0] }, TODAY), false);
  assert.equal(asksRuleChoice(daily, { name: "Other" }, TODAY), false);
  assert.equal(asksRuleChoice(daily, { days: [1] }, TODAY), true);
  assert.equal(changesRules(daily, { days: [1] }), true);
});

test("a schedule change from today leaves earlier weekends off", () => {
  const weekdays = { ...daily, days: [0, 1, 2, 3, 4] };
  const weekdaysLog = Object.fromEntries(Object.entries(days("2026-11-01", "2026-11-23")).filter(([d]) => ![0, 6].includes(new Date(d).getUTCDay())));
  const data = dataWith(weekdays, logOf("h", weekdaysLog));
  const everyDay = withRules(weekdays, { days: [] }, TODAY, "today");
  assert.equal(isOff(data, everyDay, "2026-11-22"), true);
  assert.equal(isOff(data, everyDay, "2026-11-29"), false);
  assert.equal(rate(data, everyDay, TODAY, 30), 1);
});

test("every-N days keep their old anchor before the change", () => {
  const every3 = withRules({ ...daily, every: 2 }, { every: 3, everyFrom: TODAY }, TODAY, "today");
  const data = dataWith(every3);
  assert.deepEqual(["2026-11-03", "2026-11-04", "2026-11-26", "2026-11-27"].map((d) => isOff(data, every3, d)), [false, true, true, false]);
});

test("a type change keeps past check-ins done, and a streak starts again at the change", () => {
  const data = dataWith(daily, logOf("h", days("2026-11-01", "2026-11-23")));
  const avoid = withRules(daily, { type: "avoid" }, TODAY, "today");
  assert.equal(habitAt(avoid, "2026-11-10").type, "check");
  assert.equal(rate(data, avoid, "2026-11-23", 7), 1);
  assert.deepEqual(streak(data, avoid, TODAY), { current: 1, best: 23, unit: "day" });
  const m = measureOf(data, [avoid], "2026-11-01", TODAY);
  assert.deepEqual([m.rows[0].due, m.rows[0].done, m.rows[0].slips, m.checkins, m.rows[0].rule.type], [24, 24, 0, 23, "avoid"]);
  assert.deepEqual(measureOf(data, [avoid], "2026-11-01", "2026-11-23").rows[0].rule.type, "check");
});

test("a streak's best counts only periods in the habit's current unit", () => {
  const data = dataWith(daily, logOf("h", days("2026-11-01", "2026-11-23")));
  const weekly = withRules(daily, { type: "weekly", target: 3 }, TODAY, "today");
  assert.deepEqual(streak(data, weekly, TODAY), { current: 0, best: 0, unit: "week" });
});

test("daily to weekly mid-week: the change's week is weekly and counts that week's earlier days", () => {
  const weekly = withRules(daily, { type: "weekly", target: 3 }, "2026-11-25", "today");
  const data = dataWith(weekly, logOf("h", { "2026-11-23": 1, "2026-11-24": 1, "2026-11-26": 1 }));
  const m = measureOf(data, [weekly], "2026-11-23", "2026-11-29", "2026-11-29");
  assert.deepEqual([m.due, m.done, m.rows[0].longest], [3, 3, 2]);
  assert.equal(streak(data, weekly, "2026-11-29").current, 1);
});

test("a type change mid-period keeps the cut period's days before it only if they met the old target", () => {
  const weekly = { ...daily, type: "weekly", target: 1 };
  const check = withRules(weekly, { type: "check" }, "2026-11-25", "today");
  const data = dataWith(check, logOf("h", { "2026-11-17": 1, "2026-11-23": 1, "2026-11-25": 1 }));
  const met = measureOf(data, [check], "2026-11-16", "2026-11-25", "2026-11-25");
  assert.deepEqual([met.due, met.done], [3, 3]);
  delete data.log["2026-11-23"];
  const unmet = measureOf(data, [check], "2026-11-16", "2026-11-25", "2026-11-25");
  assert.deepEqual([unmet.due, unmet.done], [2, 2]);
  const monthly = withRules({ ...daily, type: "monthly", target: 1, start: "2026-10-01" }, { type: "check" }, "2026-11-18", "today");
  const month = measureOf(dataWith(monthly, { "2026-11-05": { h: 1 } }), [monthly], "2026-11-01", "2026-11-17", "2026-11-18");
  assert.deepEqual([month.due, month.done], [1, 1]);
});

test("monthly to weekly at the start of a month keeps the month that ended before it", () => {
  const monthly = { ...daily, type: "monthly", target: 2, start: "2026-10-01" };
  const weekly = withRules(monthly, { type: "weekly", target: 1 }, "2026-12-02", "today");
  const data = dataWith(weekly, { "2026-10-05": { h: 2 }, "2026-11-05": { h: 2 } });
  const m = measureOf(data, [weekly], "2026-11-01", "2026-11-30", "2026-12-02");
  assert.deepEqual([m.due, m.done], [1, 1]);
});

test("an era that ends before a moved start is ignored", () => {
  const water = withRules({ ...daily, type: "amount", target: 8 }, { target: 10 }, "2026-11-10", "today");
  const moved = { ...water, start: "2026-11-15" };
  const data = dataWith(moved, { "2026-11-16": { h: 10 } });
  assert.equal(habitAt(moved, "2026-11-16").target, 10);
  assert.equal(streak(data, moved, "2026-11-16").best, 1);
});

test("a weekly target changed mid-week applies to the whole week", () => {
  const weekly = { ...daily, type: "weekly", target: 3 };
  const data = dataWith(weekly, { "2026-11-23": { h: 1 }, [TODAY]: { h: 1 } });
  const lower = withRules(weekly, { target: 2 }, TODAY, "today");
  assert.equal(streak(data, lower, TODAY).current, 1);
  assert.equal(goalProgress(data, { start: "2026-11-01", deadline: "2026-11-30", target: 4 }, lower, TODAY).done, 2);
});

test("an older version editing the habit changes only the current era", () => {
  const water = withRules({ ...daily, type: "amount", target: 8 }, { target: 10 }, TODAY, "today");
  const edited = { ...water, target: 12 };
  assert.equal(habitAt(edited, "2026-11-20").target, 8);
  assert.equal(habitAt(edited, TODAY).target, 12);
});

test("eras from a malformed file are cleaned instead of breaking the app", () => {
  const data = dataWith([], { "2026-11-05": { h: 1, other: 1 } });
  for (const past of ["abc", { length: 1 }, [null], [{ until: 20260101 }], [{ until: "x" }]]) {
    const habit = { ...daily, past };
    assert.equal(streak(data, habit, TODAY).best, 1);
    assert.equal(rulesSince(habit), habit.start);
    assert.equal(asksRuleChoice(habit, { target: 2 }, TODAY), true);
  }
  const swapped = { ...daily, past: [{ until: "2026-11-30", id: "other", start: "2020-01-01", days: [9, 2] }] };
  assert.deepEqual([habitAt(swapped, "2026-11-05").id, habitAt(swapped, "2026-11-05").start, habitAt(swapped, "2026-11-05").days], ["h", "2026-11-01", [2]]);
});

test("the calendar starts a changed habit on its current schedule", () => {
  const habit = withRules({ ...daily, start: "2026-01-05", every: 2, everyFrom: "2026-01-05" }, { every: 3, everyFrom: "2026-03-10" }, "2026-03-10", "today");
  assert.match(toIcs(dataWith(habit), new Date(Date.UTC(2026, 2, 11))), /DTSTART;VALUE=DATE:20260106\r\n[^]*?INTERVAL=3/);
});

test("correlations leave out days from an era they cannot read", () => {
  const a = withRules({ ...daily, id: "a", type: "avoid" }, { type: "check" }, "2026-11-20", "today");
  const b = { ...daily, id: "b" };
  const data = dataWith([a, b], logOf("b", days("2026-11-01", "2026-11-19")));
  assert.deepEqual(correlations(data, [a, b], TODAY, { minDays: 3 }), []);
});

test("an archived habit counts until the day it was archived, or a later last entry", () => {
  const data = dataWith(daily, { "2026-11-05": { h: 1 } });
  assert.equal(lastDay(data, daily, TODAY), TODAY);
  assert.equal(lastDay(data, { ...daily, archived: true, archivedAt: "2026-11-10" }, TODAY), "2026-11-10");
  assert.equal(lastDay(data, { ...daily, archived: true }, TODAY), "2026-11-05");
  assert.equal(lastDay(data, { ...daily, archived: true, archivedAt: "2026-11-02" }, TODAY), "2026-11-05");
  const archived = { ...daily, archived: true, archivedAt: "2026-11-10" };
  assert.equal(measureOf(data, [archived], "2026-11-16", "2026-11-22").rows.length, 0);
  assert.equal(measureOf(data, [archived], "2026-11-01", "2026-11-15").rows[0].due, 10);
});

test("today counts only once done, and days before the start or off do not count", () => {
  const late = { ...daily, start: "2026-11-20", days: [0, 1, 2, 3, 4] };
  const data = dataWith(late, { "2026-11-20": { h: 1 }, "2026-11-23": { h: 1 } });
  data.breaks.push({ id: "b", from: "2026-11-21", to: "2026-11-21", habitId: "" });
  let m = measureOf(data, [late], "2026-11-16", TODAY);
  assert.deepEqual([m.due, m.done, m.rate, m.perfectDays, m.activeDays], [2, 2, 1, 2, 2]);
  data.log[TODAY] = { h: 1 };
  m = measureOf(data, [late], "2026-11-16", TODAY);
  assert.deepEqual([m.due, m.done, m.perfectDays], [3, 3, 3]);
});

test("today is not a perfect day while a habit due today is still open", () => {
  const other = { ...daily, id: "o" };
  const data = dataWith([daily, other], { [TODAY]: { h: 1 } });
  assert.equal(measureOf(data, [daily, other], TODAY, TODAY).perfectDays, 0);
});

test("weekly habits count on the day their target was reached, or their last day when it was not", () => {
  const weekly = { ...daily, id: "w", type: "weekly", target: 2 };
  const data = dataWith(weekly, { "2026-11-10": { w: 1 }, "2026-11-11": { w: 1 }, "2026-11-17": { w: 1 } });
  const on = (from, cut) => {
    const m = measureOf(data, [weekly], from, cut);
    return [m.due, m.done];
  };
  assert.deepEqual(on("2026-11-11", "2026-11-11"), [1, 1]);
  assert.deepEqual(on("2026-11-16", "2026-11-21"), [0, 0]);
  assert.deepEqual(on("2026-11-22", "2026-11-22"), [1, 0]);
  assert.deepEqual(on("2026-11-23", TODAY), [0, 0]);
  data.log["2026-11-23"] = { w: 2 };
  assert.deepEqual(on("2026-11-23", TODAY), [1, 1]);
});

test("a weekly habit met early in both weeks compares even, like for like", () => {
  const weekly = { ...daily, id: "w", type: "weekly", target: 1 };
  const data = dataWith(weekly, { "2026-11-16": { w: 1 }, "2026-11-23": { w: 1 } });
  const facts = buildFacts(data, [weekly], TODAY);
  const range = rangeFor("week", TODAY);
  const { before } = compare(data, facts, "week", range, "previous");
  const now = measure(data, facts, range);
  assert.deepEqual([now.due, now.done, before.due, before.done], [1, 1, 1, 1]);
});

test("a week adds up what was due and done, and a year totals check-ins, amounts and the longest run", () => {
  const weekly = { ...daily, id: "w", type: "weekly", target: 3 };
  const pages = { ...daily, id: "p", type: "amount", target: 10, unit: "pages" };
  const data = dataWith([daily, weekly, pages], {
    "2026-11-16": { h: 1, w: 1, p: 10 },
    "2026-11-17": { h: 1, w: 1, p: 4 },
    "2026-11-20": { h: 1 },
  });
  data.tasks.push({ id: "t", title: "x", done: "2026-11-18", due: "2026-11-17" }, { id: "u", title: "y", done: "", due: "2026-11-19" });
  data.days["2026-11-16"] = { mood: 5, energy: 3 };
  const week = measureOf(data, [daily, weekly, pages], "2026-11-16", "2026-11-22");
  assert.deepEqual(week.rows.map((r) => [r.habit.id, r.done, r.due]), [["h", 3, 7], ["w", 0, 1], ["p", 1, 7]]);
  assert.deepEqual([week.done, week.due, week.tasksDone, week.onTime, week.overdue, week.mood, week.energy], [4, 15, 1, 0, 1, 5, 3]);
  assert.deepEqual([week.rows[2].total, week.rows[2].average, week.rows[2].bestDay], [14, 2, 10]);
  const year = measureOf(data, [daily, weekly, pages], "2026-01-01", TODAY);
  assert.deepEqual([year.checkins, year.activeDays, year.tasksDone, year.top.habit.id, year.top.count], [7, 3, 1, "h", 3]);
  assert.deepEqual([year.longest.habit.id, year.longest.count], ["h", 2]);
  assert.deepEqual(amountTotals(year).map((x) => [x.habit.id, x.total]), [["p", 14]]);
});

test("the longest run is in days: weekly runs and a run across a type change do not count", () => {
  const weekly = { ...daily, id: "w", type: "weekly", target: 1, start: "2026-08-03" };
  const short = { ...daily, start: "2026-11-01" };
  const data = dataWith([weekly, short], { ...logOf("h", days("2026-11-01", "2026-11-05")) });
  for (let d = new Date("2026-08-03T00:00:00Z"); d < new Date("2026-11-24T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 7)) {
    const k = d.toISOString().slice(0, 10);
    data.log[k] = { ...data.log[k], w: 1 };
  }
  assert.deepEqual(measureOf(data, [weekly, short], "2026-01-01", TODAY).longest, { habit: short, count: 5 });
  const changed = withRules({ ...daily, type: "check" }, { type: "amount", target: 1 }, "2026-11-11", "today");
  const both = dataWith(changed, logOf("h", days("2026-11-01", "2026-11-23")));
  assert.equal(measureOf(both, [changed], "2026-11-01", "2026-11-23").rows[0].longest, 13);
});

test("an every-N habit's longest run in a year counts the days it was scheduled", () => {
  const habit = { ...daily, start: "2025-12-31", every: 2 };
  const data = dataWith(habit, logOf("h", { "2026-01-02": 1, "2026-01-04": 1, "2026-01-06": 1, "2026-01-08": 1 }));
  assert.equal(measureOf(data, [habit], "2026-01-01", "2026-01-08", "2026-01-08").longest.count, 4);
});

test("an avoid habit counts slips, clean days and its longest clean run, and stays out of the longest streak", () => {
  const avoid = { ...daily, type: "avoid" };
  const data = dataWith(avoid, { "2026-11-10": { h: 1 } });
  const m = measureOf(data, [avoid], "2026-11-01", TODAY);
  assert.deepEqual([m.slips, m.rows[0].clean, m.longest, m.checkins], [1, 23, null, 0]);
  assert.deepEqual(m.longestClean, { habit: avoid, count: 14 });
});

test("an amount's average leaves out today's unfinished amount, and a day off logged anyway counts", () => {
  const pages = { ...daily, type: "amount", target: 10, days: [0, 1, 2, 3, 4] };
  const data = dataWith(pages, { "2026-11-16": { h: 10 }, "2026-11-22": { h: 30 }, [TODAY]: { h: 5 } });
  const row = measureOf(data, [pages], "2026-11-16", TODAY).rows[0];
  assert.deepEqual([row.total, row.dailyDue, row.average], [45, 7, 40 / 7]);
});

test("periods run Monday to Sunday, by calendar month and by year", () => {
  assert.deepEqual(rangeFor("week", TODAY), { from: "2026-11-23", to: "2026-11-29", cut: TODAY });
  assert.deepEqual(rangeFor("month", TODAY, { back: 9 }), { from: "2026-02-01", to: "2026-02-28", cut: "2026-02-28" });
  assert.deepEqual(rangeFor("year", TODAY, { back: 2 }), { from: "2024-01-01", to: "2024-12-31", cut: "2024-12-31" });
  assert.deepEqual(rangeFor("custom", TODAY, { from: "2026-11-01", to: "2026-11-10", back: 1 }), { from: "2026-10-22", to: "2026-10-31", cut: "2026-10-31" });
  assert.deepEqual(periodAround("day", TODAY), { from: TODAY, to: TODAY });
  assert.deepEqual([comparesFor("year"), comparesFor("custom")], [["previous", "average", "best"], ["previous", "lastYear", "average"]]);
});

test("comparisons cut earlier periods at the same point, clipped to shorter months and leap days", () => {
  const month = rangeFor("month", "2026-03-31");
  assert.deepEqual(comparisonRanges("month", month, "previous"), [{ from: "2026-02-01", to: "2026-02-28", cut: "2026-02-28" }]);
  const midMonth = rangeFor("month", "2026-03-12");
  assert.deepEqual(comparisonRanges("month", midMonth, "previous"), [{ from: "2026-02-01", to: "2026-02-28", cut: "2026-02-12" }]);
  assert.equal(comparisonRanges("month", midMonth, "previous", { full: true })[0].cut, "2026-02-28");
  const leapDay = rangeFor("year", "2028-02-29");
  assert.deepEqual(comparisonRanges("year", leapDay, "previous"), [{ from: "2027-01-01", to: "2027-12-31", cut: "2027-02-28" }]);
  const week = rangeFor("week", TODAY);
  assert.deepEqual(comparisonRanges("week", week, "lastYear"), [{ from: "2025-11-24", to: "2025-11-30", cut: "2025-11-25" }]);
  assert.deepEqual(comparisonRanges("month", rangeFor("month", TODAY), "lastYear")[0], { from: "2025-11-01", to: "2025-11-30", cut: "2025-11-24" });
  assert.deepEqual(comparisonRanges("week", week, "average").map((r) => r.from), ["2026-11-16", "2026-11-09", "2026-11-02", "2026-10-26"]);
});

test("an average comparison takes the mean of each figure and of each habit, over ranges with data", () => {
  const data = dataWith(daily, logOf("h", { "2026-11-02": 1, "2026-11-03": 1, "2026-11-09": 1 }));
  const facts = buildFacts(data, [daily], TODAY);
  const { before, ranges } = compare(data, facts, "week", rangeFor("week", TODAY), "average");
  assert.deepEqual(ranges.map((r) => r.from), ["2026-11-16", "2026-11-09", "2026-11-02"]);
  assert.deepEqual([before.rate, before.rows[0].done], [(0 + 0.5 + 1) / 3, 1]);
  assert.equal(averageMeasure([before]), before);
});

test("the best period is the whole past one with the highest rate, cut like the current one", () => {
  const data = dataWith(daily, logOf("h", { ...days("2026-11-02", "2026-11-08"), ...days("2026-11-16", "2026-11-22") }));
  const facts = buildFacts(data, [daily], TODAY);
  const best = bestRange(data, facts, "week", rangeFor("week", TODAY));
  assert.deepEqual([best.whole.from, best.value, best.range.cut, best.measure.done], ["2026-11-16", 1, "2026-11-17", 2]);
  assert.equal(bestRange(data, facts, "week", rangeFor("week", TODAY), { full: true }).measure.done, 7);
  const extremes = habitExtremes(facts[0], "week", TODAY);
  assert.deepEqual([extremes.best.from, extremes.worst.from], ["2026-11-16", "2026-11-09"]);
});

test("a trend lists whole earlier periods and the current one, with the same periods a year before", () => {
  const ranges = trendRanges("month", rangeFor("month", TODAY), 3);
  assert.deepEqual(ranges.map((r) => [r.from, r.cut]), [["2026-09-01", "2026-09-30"], ["2026-10-01", "2026-10-31"], ["2026-11-01", TODAY]]);
  assert.deepEqual(yearEarlier("month", ranges).map((r) => [r.from, r.cut]), [["2025-09-01", "2025-09-30"], ["2025-10-01", "2025-10-31"], ["2025-11-01", "2025-11-24"]]);
});

test("a distribution bins the values logged on due days", () => {
  const pages = { ...daily, type: "amount", target: 10 };
  const data = dataWith(pages, logOf("h", { "2026-11-01": 2, "2026-11-02": 12, "2026-11-03": 6 }));
  const bins = distribution(habitFacts(data, pages, TODAY), "2026-11-01", "2026-11-03", 3);
  assert.deepEqual([bins.map((b) => b.count), bins[2].to], [[1, 1, 1], 12]);
});

test("the metrics CSV escapes text and keeps spreadsheet formulas from running", () => {
  const evil = { ...daily, name: '=HYPERLINK("x"), "y"' };
  const data = dataWith(evil, { "2026-11-23": { h: 1 } });
  const csv = metricsCsv([measureOf(data, [evil], "2026-11-23", "2026-11-23")], (h) => h.name, () => "Week");
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^period,from,to,habit,due,done,rate/);
  assert.match(lines[2], /^Week,2026-11-23,2026-11-23,"'=HYPERLINK\(""x""\), ""y""",1,1,1,1/);
});

test("recent levels follow each day's rules", () => {
  const water = withRules({ ...daily, type: "amount", target: 4 }, { target: 8 }, TODAY, "today");
  const data = dataWith(water, { "2026-11-23": { h: 4 } });
  assert.equal(recentLevels(data, water, TODAY, 1)[0], 4);
});

test("a week met by an entry dated after today still counts today", () => {
  const weekly = { ...daily, type: "weekly", target: 2 };
  const data = dataWith(weekly, { "2026-11-23": { h: 1 }, "2026-11-25": { h: 1 } });
  const m = measureOf(data, [weekly], "2026-11-23", TODAY);
  assert.deepEqual([m.due, m.done], [1, 1]);
});

test("an avoid habit skips the days it was archived, but not other breaks", () => {
  const avoid = { ...daily, type: "avoid" };
  const data = dataWith(avoid);
  data.breaks.push({ id: "a", from: "2026-11-05", to: "2026-11-20", habitId: "h", archived: true }, { id: "b", from: "2026-11-01", to: "2026-11-04", habitId: "" });
  assert.equal(isOff(data, avoid, "2026-11-10"), true);
  assert.equal(isOff(data, avoid, "2026-11-02"), false);
  assert.deepEqual(streak(data, avoid, TODAY), { current: 8, best: 8, unit: "day" });
  assert.equal(measureOf(data, [avoid], "2026-11-01", TODAY).rows[0].due, 8);
});

test("a clean run starts again where an avoid habit's type changed", () => {
  const avoid = withRules({ ...daily, type: "avoid" }, { type: "check" }, "2026-11-11", "today");
  const back = withRules(avoid, { type: "avoid" }, "2026-11-16", "today");
  const data = dataWith(back, logOf("h", days("2026-11-11", "2026-11-15")));
  const row = measureOf(data, [back], "2026-11-01", TODAY).rows[0];
  assert.deepEqual([row.longestClean, row.longest, row.clean], [10, 5, 19]);
});

test("a slip on an avoid habit's archived day is a slip, not a check-in", () => {
  const avoid = { ...daily, type: "avoid" };
  const data = dataWith(avoid, { "2026-11-15": { h: 1 } });
  data.breaks.push({ id: "a", from: "2026-11-10", to: "2026-11-20", habitId: "h", archived: true });
  const m = measureOf(data, [avoid], "2026-11-01", TODAY);
  assert.deepEqual([m.checkins, m.activeDays, m.slips], [0, 0, 1]);
});

test("restoring a habit breaks only the days after it was archived, and only when that day is known", () => {
  const id = () => "b";
  const archived = archiveOps(daily, "2026-11-10")[0].habit;
  const data = dataWith(archived, { "2026-11-05": { h: 1 } });
  assert.deepEqual(restoreOps(data, archived, TODAY, id)[1].break, { id: "b", from: "2026-11-11", to: "2026-11-23", habitId: "h", archived: true });
  assert.equal(restoreOps(data, { ...archived, archivedAt: undefined }, TODAY, id).length, 1);
  assert.equal(restoreOps(data, { ...archived, archivedAt: TODAY }, TODAY, id).length, 1);
  data.log["2026-11-20"] = { h: 1 };
  assert.equal(restoreOps(data, archived, TODAY, id)[1].break.from, "2026-11-21");
  assert.equal(restoreOps(data, archived, TODAY, id)[0].habit.archived, false);
});

test("an avoid habit archived before archive days were kept counts on, whatever its last slip", () => {
  const avoid = { ...daily, type: "avoid", archived: true };
  assert.equal(lastDay(dataWith(avoid, { "2026-11-03": { h: 1 } }), avoid, TODAY), TODAY);
});

test("eras dated today or later from a wrong clock do not lock the rules, and unknown era fields are kept", () => {
  const habit = { ...daily, type: "amount", target: 8, past: [{ until: "2026-11-01", target: 4, unit: "ml" }, { until: "2027-06-30", type: "check" }] };
  assert.equal(asksRuleChoice(habit, { target: 10 }, TODAY), true);
  const next = withRules(habit, { target: 10 }, TODAY, "today");
  assert.deepEqual(next.past.map((e) => [e.until, e.unit]), [["2026-11-01", "ml"], ["2026-11-23", undefined]]);
  assert.equal(habitAt(next, TODAY).target, 10);
});

test("history before 1970 is not walked", () => {
  const ancient = { ...daily, start: "0024-05-25" };
  const data = dataWith(ancient, { "2026-11-23": { h: 1 } });
  assert.equal(habitFacts(data, ancient, TODAY).start, "1970-01-01");
  assert.equal(measureOf(data, [ancient], "0001-01-01", TODAY).from, "1970-01-01");
});

test("a day with a slip is not perfect", () => {
  const avoid = { ...daily, id: "a", type: "avoid" };
  const data = dataWith([daily, avoid], { "2026-11-20": { h: 1, a: 1 }, "2026-11-21": { h: 1 } });
  assert.equal(measureOf(data, [daily, avoid], "2026-11-20", "2026-11-21").perfectDays, 1);
});

test("a value that is not a number is ignored", () => {
  const pages = { ...daily, type: "amount", target: 10 };
  const row = measureOf(dataWith(pages, { "2026-11-20": { h: "2 pages" }, "2026-11-21": { h: 10 } }), [pages], "2026-11-20", "2026-11-21").rows[0];
  assert.deepEqual([row.total, row.average], [10, 5]);
});

test("a task created after the end of a range is not overdue in it", () => {
  const data = dataWith(daily);
  data.tasks.push({ id: "t", title: "x", due: "2026-11-10", created: "2026-11-20", done: "" });
  assert.equal(measureOf(data, [daily], "2026-11-01", "2026-11-15").overdue, 0);
  assert.equal(measureOf(data, [daily], "2026-11-01", "2026-11-21").overdue, 1);
});

test("the last-days rate counts a week on the day it was met, like Compare", () => {
  const weekly = { ...daily, type: "weekly", target: 1 };
  const data = dataWith(weekly, { "2026-11-16": { h: 1 } });
  assert.equal(rate(data, weekly, "2026-11-25", 7), null);
  assert.equal(rate(data, weekly, "2026-11-22", 7), 1);
});

test("many eras resolve to the one covering each date", () => {
  const past = Array.from({ length: 50 }, (_, i) => ({ until: `2025-${String(1 + Math.floor(i / 5)).padStart(2, "0")}-${String(1 + (i % 5) * 5).padStart(2, "0")}`, target: i + 1 }));
  const habit = { ...daily, type: "amount", start: "2025-01-01", past };
  assert.equal(habitAt(habit, "2025-01-01").target, 1);
  assert.equal(habitAt(habit, "2025-01-02").target, 2);
  assert.equal(habitAt(habit, "2025-10-21").target, 50);
  assert.equal(habitAt(habit, "2025-10-22"), habit);
});
