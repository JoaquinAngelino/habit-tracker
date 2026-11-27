import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyData, streak, rate, isOff, level, goalProgress, habitAt, withRules, rulesSince, changesRules, lastDay, recentLevels } from "../src/lib.js";
import { buildFacts, measure, rangeFor, comparisonRanges, averageMeasure, bestRange, trendRanges, yearEarlier, habitExtremes, distribution, metricsCsv, periodAround } from "../src/metrics.js";

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
const measureOf = (data, habits, from, cut, today = TODAY) => measure(data, buildFacts(data, habits, today), { from, cut });

test("raising a target from today keeps past days done under the old target", () => {
  const water = { ...daily, type: "amount", target: 8, unit: "glasses" };
  const data = dataWith(water, logOf("h", days("2026-11-01", "2026-11-23", 8)));
  const raised = withRules(water, { target: 10 }, TODAY, true);
  assert.deepEqual(raised.past, [{ until: "2026-11-23", type: "amount", target: 8, days: [], every: 0, everyFrom: "2026-11-01" }]);
  assert.equal(rate(data, raised, TODAY, 7), 1);
  assert.equal(streak(data, raised, TODAY).current, 23);
  assert.equal(level(data, raised, "2026-11-20", TODAY), 4);
  data.log[TODAY] = { h: 8 };
  assert.equal(level(data, raised, TODAY, TODAY), 4 * 0 + Math.ceil((8 / 10) * 4));
  assert.equal(streak(data, raised, TODAY).current, 23);
  assert.equal(rulesSince(raised), TODAY);
});

test("correcting the rules for all history applies them to past days too", () => {
  const water = { ...daily, type: "amount", target: 8 };
  const data = dataWith(water, logOf("h", days("2026-11-01", "2026-11-23", 8)));
  const corrected = withRules(water, { target: 10 }, TODAY, false);
  assert.equal(corrected.past, undefined);
  assert.equal(rate(data, corrected, TODAY, 7), 0);
});

test("several edits on one day make one era, and a habit started today never gets one", () => {
  const once = withRules({ ...daily, type: "amount", target: 8 }, { target: 9 }, TODAY, true);
  const twice = withRules(once, { target: 10 }, TODAY, true);
  assert.equal(twice.past.length, 1);
  assert.equal(twice.past[0].target, 8);
  assert.equal(twice.target, 10);
  assert.equal(withRules({ ...daily, start: TODAY }, { days: [0] }, TODAY, true).past, undefined);
  assert.equal(withRules(daily, { name: "Other" }, TODAY, true).past, undefined);
  assert.equal(changesRules(daily, { name: "Other" }), false);
  assert.equal(changesRules(daily, { days: [1] }), true);
});

test("a schedule change from today leaves earlier weekends off", () => {
  const weekdays = { ...daily, days: [0, 1, 2, 3, 4] };
  const data = dataWith(weekdays, logOf("h", Object.fromEntries(Object.entries(days("2026-11-01", "2026-11-23")).filter(([d]) => ![0, 6].includes(new Date(d).getUTCDay())))));
  const everyDay = withRules(weekdays, { days: [] }, TODAY, true);
  assert.equal(isOff(data, everyDay, "2026-11-22"), true);
  assert.equal(isOff(data, everyDay, "2026-11-29"), false);
  assert.equal(rate(data, everyDay, TODAY, 30), 1);
});

test("every-N days keep their old anchor before the change", () => {
  const every2 = { ...daily, every: 2 };
  const every3 = withRules(every2, { every: 3, everyFrom: TODAY }, TODAY, true);
  assert.equal(isOff(dataWith(every3), every3, "2026-11-03"), false);
  assert.equal(isOff(dataWith(every3), every3, "2026-11-04"), true);
  assert.equal(isOff(dataWith(every3), every3, "2026-11-26"), true);
  assert.equal(isOff(dataWith(every3), every3, "2026-11-27"), false);
});

test("a type change keeps past check-ins done, and a streak starts again at the change", () => {
  const data = dataWith(daily, logOf("h", days("2026-11-01", "2026-11-23")));
  const avoid = withRules(daily, { type: "avoid" }, TODAY, true);
  assert.equal(habitAt(avoid, "2026-11-10").type, "check");
  assert.equal(rate(data, avoid, "2026-11-23", 7), 1);
  assert.deepEqual(streak(data, avoid, TODAY), { current: 1, best: 23, unit: "day" });
  const m = measureOf(data, [avoid], "2026-11-01", TODAY);
  assert.deepEqual([m.rows[0].due, m.rows[0].done, m.rows[0].slips, m.checkins], [24, 24, 0, 23]);
});

test("a weekly target changed mid-week applies to the whole week", () => {
  const weekly = { ...daily, type: "weekly", target: 3 };
  const data = dataWith(weekly, { "2026-11-23": { h: 1 }, [TODAY]: { h: 1 } });
  const lower = withRules(weekly, { target: 2 }, TODAY, true);
  assert.equal(streak(data, lower, TODAY).current, 1);
  assert.equal(goalProgress(data, { start: "2026-11-01", deadline: "2026-11-30", target: 4 }, lower, TODAY).done, 2);
});

test("an older version editing the habit changes only the current era", () => {
  const water = withRules({ ...daily, type: "amount", target: 8 }, { target: 10 }, TODAY, true);
  const edited = { ...water, target: 12 };
  assert.equal(habitAt(edited, "2026-11-20").target, 8);
  assert.equal(habitAt(edited, TODAY).target, 12);
});

test("an archived habit counts until it was archived, or its last entry when that was not kept", () => {
  const data = dataWith(daily, { "2026-11-05": { h: 1 } });
  assert.equal(lastDay(data, daily, TODAY), TODAY);
  assert.equal(lastDay(data, { ...daily, archived: true, archivedAt: "2026-11-10" }, TODAY), "2026-11-10");
  assert.equal(lastDay(data, { ...daily, archived: true }, TODAY), "2026-11-05");
  const archived = { ...daily, archived: true, archivedAt: "2026-11-10" };
  assert.equal(measureOf(data, [archived], "2026-11-16", "2026-11-22").rows.length, 0);
  assert.deepEqual([measureOf(data, [archived], "2026-11-01", "2026-11-15").rows[0].due], [9]);
});

test("today counts only once done, and days before the start or off do not count", () => {
  const late = { ...daily, start: "2026-11-20", days: [0, 1, 2, 3, 4] };
  const data = dataWith(late, { "2026-11-20": { h: 1 }, "2026-11-23": { h: 1 } });
  data.breaks.push({ id: "b", from: "2026-11-21", to: "2026-11-21", habitId: "" });
  let m = measureOf(data, [late], "2026-11-16", TODAY);
  assert.deepEqual([m.due, m.done, m.rate, m.perfectDays, m.activeDays], [2, 2, 1, 2, 2]);
  data.log[TODAY] = { h: 1 };
  m = measureOf(data, [late], "2026-11-16", TODAY);
  assert.deepEqual([m.due, m.done], [3, 3]);
});

test("weekly and monthly habits count once per period, on its last day or when met while open", () => {
  const weekly = { ...daily, id: "w", type: "weekly", target: 2 };
  const data = dataWith(weekly, { "2026-11-10": { w: 1 }, "2026-11-11": { w: 1 }, "2026-11-17": { w: 1 } });
  assert.deepEqual([measureOf(data, [weekly], "2026-11-15", "2026-11-15").due, measureOf(data, [weekly], "2026-11-15", "2026-11-15").done], [1, 1]);
  assert.equal(measureOf(data, [weekly], "2026-11-16", "2026-11-21").due, 0);
  assert.deepEqual([measureOf(data, [weekly], "2026-11-22", "2026-11-22").due, measureOf(data, [weekly], "2026-11-22", "2026-11-22").done], [1, 0]);
  assert.equal(measureOf(data, [weekly], "2026-11-23", TODAY).due, 0);
  data.log["2026-11-23"] = { w: 2 };
  assert.deepEqual([measureOf(data, [weekly], "2026-11-23", TODAY).due, measureOf(data, [weekly], "2026-11-23", TODAY).done], [1, 1]);
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
  assert.deepEqual([year.checkins, year.activeDays, year.tasksDone, year.top.habit.id, year.top.days], [7, 3, 1, "h", 3]);
  assert.deepEqual([year.longest.habit.id, year.longest.count], ["h", 2]);
});

test("an every-N habit's longest run in a year counts the days it was scheduled", () => {
  const habit = { ...daily, start: "2025-12-31", every: 2 };
  const data = dataWith(habit, logOf("h", { "2026-01-02": 1, "2026-01-04": 1, "2026-01-06": 1, "2026-01-08": 1 }));
  assert.equal(measureOf(data, [habit], "2026-01-01", "2026-01-08", "2026-01-08").longest.count, 4);
});

test("an avoid habit counts slips and clean days, and stays out of the longest streak", () => {
  const avoid = { ...daily, type: "avoid" };
  const data = dataWith(avoid, { "2026-11-10": { h: 1 } });
  const m = measureOf(data, [avoid], "2026-11-01", TODAY);
  assert.deepEqual([m.slips, m.rows[0].clean, m.rows[0].longest, m.longest, m.checkins], [1, 23, 14, null, 0]);
});

test("periods run Monday to Sunday, by calendar month and by year", () => {
  assert.deepEqual(rangeFor("week", TODAY), { from: "2026-11-23", to: "2026-11-29", cut: TODAY });
  assert.deepEqual(rangeFor("month", TODAY, { back: 9 }), { from: "2026-02-01", to: "2026-02-28", cut: "2026-02-28" });
  assert.deepEqual(rangeFor("year", TODAY, { back: 2 }), { from: "2024-01-01", to: "2024-12-31", cut: "2024-12-31" });
  assert.deepEqual(rangeFor("custom", TODAY, { from: "2026-11-01", to: "2026-11-10", back: 1 }), { from: "2026-10-22", to: "2026-10-31", cut: "2026-10-31" });
  assert.deepEqual(periodAround("day", TODAY), { from: TODAY, to: TODAY });
});

test("comparisons cut earlier periods at the same point, clipped to shorter months and leap days", () => {
  const month = rangeFor("month", "2026-03-31");
  assert.deepEqual(comparisonRanges("month", month, "previous"), [{ from: "2026-02-01", to: "2026-02-28", cut: "2026-02-28" }]);
  const midMonth = rangeFor("month", "2026-03-12");
  assert.deepEqual(comparisonRanges("month", midMonth, "previous"), [{ from: "2026-02-01", to: "2026-02-28", cut: "2026-02-12" }]);
  assert.deepEqual(comparisonRanges("month", midMonth, "previous", { full: true })[0].cut, "2026-02-28");
  const leapDay = rangeFor("year", "2028-02-29");
  assert.deepEqual(comparisonRanges("year", leapDay, "lastYear"), [{ from: "2027-01-01", to: "2027-12-31", cut: "2027-02-28" }]);
  const week = rangeFor("week", TODAY);
  assert.deepEqual(comparisonRanges("week", week, "lastYear"), [{ from: "2025-11-24", to: "2025-11-30", cut: "2025-11-25" }]);
  assert.deepEqual(comparisonRanges("month", rangeFor("month", TODAY), "lastYear")[0], { from: "2025-11-01", to: "2025-11-30", cut: "2025-11-24" });
  assert.deepEqual(comparisonRanges("week", week, "average").map((r) => r.from), ["2026-11-16", "2026-11-09", "2026-11-02", "2026-10-26"]);
});

test("an average comparison takes the mean of each figure and of each habit", () => {
  const data = dataWith(daily, logOf("h", { "2026-11-02": 1, "2026-11-03": 1, "2026-11-09": 1 }));
  const facts = buildFacts(data, [daily], TODAY);
  const ranges = comparisonRanges("week", rangeFor("week", TODAY), "average").slice(0, 3);
  const avg = averageMeasure(ranges.map((r) => measure(data, facts, r)));
  assert.equal(avg.rate, (0 + 0.5 + 1) / 3);
  assert.equal(avg.rows[0].done, 1);
});

test("the best period is the past whole one with the highest rate, the latest on a tie", () => {
  const data = dataWith(daily, logOf("h", { ...days("2026-11-02", "2026-11-08"), ...days("2026-11-16", "2026-11-22") }));
  const facts = buildFacts(data, [daily], TODAY);
  const best = bestRange(data, facts, "week", rangeFor("week", TODAY));
  assert.equal(best.range.from, "2026-11-16");
  assert.equal(best.value, 1);
  const extremes = habitExtremes(data, facts, "h", "week", TODAY);
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
  const bins = distribution(buildFacts(data, [pages], TODAY), "h", "2026-11-01", "2026-11-03", 3);
  assert.deepEqual(bins.map((b) => b.count), [1, 1, 1]);
  assert.equal(bins[2].to, 12);
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
  const water = withRules({ ...daily, type: "amount", target: 4 }, { target: 8 }, TODAY, true);
  const data = dataWith(water, { "2026-11-23": { h: 4 } });
  assert.equal(recentLevels(data, water, TODAY, 1)[0], 4);
});
