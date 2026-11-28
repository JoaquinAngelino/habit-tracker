import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, streak, goalProgress, isDatedGoal, emptyData, applyOp } from "../src/lib.js";
import { habitFacts } from "../src/metrics.js";
import { fromJson } from "../src/importer.js";

const TODAY = "2026-11-24";
const habit = { id: "h", name: "Read", type: "check", target: 1, unit: "", start: "2026-11-01" };

test("a habit with missing or mistyped fields is repaired, so views can read it", () => {
  const broken = { id: "h", type: "check", unit: 5, group: 5, time: 900, days: "mon", every: 2, everyFrom: 3 };
  const data = fromJson(JSON.stringify({ habits: [broken], log: { "2026-11-03": { h: 1 }, "2026-11-02": { h: 1 }, "2026-11-04": null } }));
  const [out] = data.habits;
  assert.deepEqual([out.name, out.start, out.unit, out.group, out.time, out.days, out.everyFrom], ["", "2026-11-02", undefined, undefined, undefined, undefined, undefined]);
  assert.deepEqual(Object.keys(data.log), ["2026-11-03", "2026-11-02"]);
  assert.ok(streak(data, out, TODAY));
  assert.ok(habitFacts(data, out, TODAY));
});

test("a habit with no usable start and nothing logged starts today", () => {
  const [out] = normalize({ habits: [{ ...habit, start: "soon" }] }).habits;
  assert.match(out.start, /^\d{4}-\d{2}-\d{2}$/);
});

test("tasks and steps with missing or mistyped fields are repaired", () => {
  const { tasks } = normalize({ tasks: [{ id: "a", due: 5, steps: "x" }, { id: "b", title: "B", due: "soon", steps: [null, { id: "s" }] }] });
  assert.deepEqual(tasks.map((x) => [x.title, x.due, x.steps]), [["", "", undefined], ["B", "", [{ id: "s", title: "" }]]]);
});

test("a goal without a start and a deadline is kept, though nothing can show it", () => {
  const goal = { id: "g", habitId: "h", target: 3, start: "2026-11-01", deadline: "2026-11-30" };
  const open = { id: "x", habitId: "h", target: 1 };
  const data = normalize({ habits: [habit], goals: [goal, open] });
  assert.deepEqual(data.goals, [goal, open]);
  assert.deepEqual(data.goals.filter(isDatedGoal), [goal]);
  assert.ok(goalProgress(data, goal, habit, TODAY));
});

test("well-formed data is left as it is, unknown fields included", () => {
  const data = {
    ...emptyData(),
    habits: [{ ...habit, extra: 1 }],
    tasks: [{ id: "t", title: "T", due: "", done: "", steps: [{ id: "s", title: "S", done: false }] }],
    log: { "2026-11-02": { h: 1 } },
  };
  const out = normalize(data);
  assert.deepEqual(out, data);
  assert.equal(out.habits[0], data.habits[0]);
  assert.equal(out.tasks[0], data.tasks[0]);
});

test("an imported edit is repaired before it is kept", () => {
  const data = applyOp(emptyData(), { t: "import", data: { habits: [{ id: "h", type: "check" }], log: {} } });
  assert.equal(data.habits[0].name, "");
});
