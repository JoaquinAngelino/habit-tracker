import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, weekStart, daysBetween, emptyData, streak, rate, level, goalProgress, applyOp, replay, queue, isDone, normalize, sortTasks, periodCount } from "../src/lib.js";

const TODAY = "2026-11-24"; // a Tuesday

function dataWith(habit, log) {
  const data = emptyData();
  data.habits.push(habit);
  for (const [date, v] of Object.entries(log)) data.log[date] = { [habit.id]: v };
  return data;
}

const daily = { id: "h", name: "Read", type: "check", target: 1, unit: "", start: "2026-11-01" };

test("date helpers work across months and find Monday", () => {
  assert.equal(addDays("2026-11-30", 1), "2026-12-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(daysBetween("2026-11-01", TODAY), 23);
  assert.equal(weekStart(TODAY), "2026-11-23");
  assert.equal(weekStart("2026-11-23"), "2026-11-23");
  assert.equal(weekStart("2026-11-29"), "2026-11-23");
});

test("daily streak keeps going while today is still open", () => {
  const data = dataWith(daily, { "2026-11-20": 1, "2026-11-21": 1, "2026-11-22": 1, "2026-11-23": 1 });
  assert.deepEqual(streak(data, daily, TODAY), { current: 4, best: 4, unit: "day" });
  data.log[TODAY] = { h: 1 };
  assert.equal(streak(data, daily, TODAY).current, 5);
});

test("a missed day resets the streak but best remembers it", () => {
  const data = dataWith(daily, { "2026-11-10": 1, "2026-11-11": 1, "2026-11-12": 1, "2026-11-23": 1 });
  assert.deepEqual(streak(data, daily, TODAY), { current: 1, best: 3, unit: "day" });
});

test("weekly streak counts weeks that met the target", () => {
  const gym = { ...daily, type: "weekly", target: 2 };
  const data = dataWith(gym, { "2026-11-03": 1, "2026-11-05": 1, "2026-11-10": 1, "2026-11-12": 1, "2026-11-17": 1, "2026-11-23": 1 });
  // Weeks of Nov 2 and Nov 9 met, Nov 16 did not, the current week is still open.
  assert.deepEqual(streak(data, gym, TODAY), { current: 0, best: 2, unit: "week" });
  data.log["2026-11-19"] = { h: 1 };
  assert.equal(streak(data, gym, TODAY).current, 3);
});

test("avoid habits count clean days, including today", () => {
  const sugar = { ...daily, type: "avoid", start: "2026-11-20" };
  const data = dataWith(sugar, { "2026-11-21": 1 });
  assert.equal(isDone(sugar, 0), true);
  assert.deepEqual(streak(data, sugar, TODAY), { current: 3, best: 3, unit: "day" });
  assert.equal(level(data, sugar, "2026-11-21", TODAY), -1);
});

test("amount habits are done once the target is reached", () => {
  const water = { ...daily, type: "amount", target: 8, unit: "glasses" };
  const data = dataWith(water, { "2026-11-23": 8, [TODAY]: 4 });
  assert.equal(streak(data, water, TODAY).current, 1);
  assert.equal(level(data, water, TODAY, TODAY), 2);
  assert.equal(level(data, water, "2026-11-22", TODAY), 0);
  assert.equal(level(data, water, "2026-10-01", TODAY), null);
});

test("rate skips an unfinished today and days before the habit started", () => {
  const habit = { ...daily, start: "2026-11-21" };
  const data = dataWith(habit, { "2026-11-21": 1, "2026-11-23": 1 });
  assert.equal(rate(data, habit, TODAY, 7), 2 / 3);
  data.log[TODAY] = { h: 1 };
  assert.equal(rate(data, habit, TODAY, 7), 3 / 4);
  assert.equal(rate(data, { ...habit, start: TODAY }, TODAY, 7), 1);
});

test("goal progress compares the count with the expected pace", () => {
  const goal = { id: "g", habitId: "h", target: 10, start: "2026-11-15", deadline: "2026-11-24" };
  const data = dataWith(daily, { "2026-11-15": 1, "2026-11-16": 1, "2026-11-17": 1 });
  const p = goalProgress(data, goal, daily, "2026-11-19");
  assert.equal(p.done, 3);
  assert.equal(p.status, "behind");
  assert.equal(p.daysLeft, 6);
  assert.equal(p.perDay, 7 / 6);
  assert.equal(goalProgress(data, goal, daily, "2026-11-16").status, "ahead");
  assert.equal(goalProgress(data, goal, daily, "2026-11-30").status, "missed");
});

test("goal progress sums amounts", () => {
  const pages = { ...daily, type: "amount", target: 20 };
  const goal = { id: "g", habitId: "h", target: 100, start: "2026-11-20", deadline: "2026-11-29" };
  const data = dataWith(pages, { "2026-11-20": 30, "2026-11-21": 25 });
  assert.equal(goalProgress(data, goal, pages, TODAY).done, 55);
});

test("ops replay on a copy and deleting a habit removes its goals and log", () => {
  const base = dataWith(daily, { [TODAY]: 1 });
  base.goals.push({ id: "g", habitId: "h", target: 5, start: TODAY, deadline: TODAY });
  const next = replay(base, [{ t: "log", date: "2026-11-23", id: "h", v: 1 }, { t: "delHabit", id: "h" }]);
  assert.deepEqual(next, emptyData());
  assert.equal(base.habits.length, 1);
  assert.deepEqual(applyOp(emptyData(), { t: "log", date: TODAY, id: "x", v: 0 }).log, {});
});

test("queue collapses back-to-back edits of the same thing", () => {
  const a = { t: "habit", habit: { id: "h", name: "R" } };
  const b = { t: "habit", habit: { id: "h", name: "Re" } };
  const c = { t: "log", date: TODAY, id: "h", v: 1 };
  assert.deepEqual(queue(queue(queue([], a), b), c), [b, c]);
  assert.deepEqual(queue([c], { t: "delGoal", id: "g" }).length, 2);
});

test("tasks sync as ops and sort open by due date, done newest first", () => {
  const task = (id, due, done = "") => ({ id, title: id, kind: "do", due, done, created: "2026-11-01" });
  const data = replay(normalize({ habits: [] }), [
    { t: "task", task: task("a", "") },
    { t: "task", task: task("b", "2026-11-30") },
    { t: "task", task: task("c", "2026-11-20") },
    { t: "task", task: task("d", "", "2026-11-21") },
    { t: "task", task: task("e", "", "2026-11-23") },
    { t: "delTask", id: "x" },
  ]);
  const { open, done } = sortTasks(data.tasks);
  assert.deepEqual(open.map((x) => x.id), ["c", "b", "a"]);
  assert.deepEqual(done.map((x) => x.id), ["e", "d"]);
  assert.equal(replay(data, [{ t: "delTask", id: "a" }]).tasks.length, 4);
  assert.equal(queue([{ t: "task", task: task("a", "") }], { t: "task", task: { ...task("a", ""), title: "ab" } }).length, 1);
});

test("monthly streak counts months that met the target", () => {
  const books = { ...daily, type: "monthly", target: 2, start: "2026-08-15" };
  const data = dataWith(books, { "2026-08-20": 1, "2026-08-31": 1, "2026-09-01": 1, "2026-10-03": 1, "2026-10-30": 1, "2026-11-02": 1 });
  // August and October met, September did not, November is still open.
  assert.deepEqual(streak(data, books, TODAY), { current: 1, best: 1, unit: "month" });
  assert.equal(periodCount(data, books, TODAY), 1);
  data.log["2026-11-24"] = { h: 1 };
  assert.deepEqual(streak(data, books, TODAY), { current: 2, best: 2, unit: "month" });
  assert.equal(rate(data, books, TODAY, 90), 3 / 4);
  data.log["2026-11-24"] = { h: 3 };
  assert.equal(periodCount(data, books, TODAY), 4);
});
