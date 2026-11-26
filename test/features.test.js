import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyData, applyOp, replay, merge, normalize, streak, rate, isOff, isDone, level, addMonths, nextDue, queue, hasData } from "../src/lib.js";
import { weekdayPattern, correlations, moodLinks, weekReview, yearRecap } from "../src/insights.js";
import { toIcs } from "../src/ics.js";
import { parseCsv, fromCsv, fromJson } from "../src/importer.js";

const TODAY = "2026-11-24"; // a Tuesday
const daily = { id: "h", name: "Read", type: "check", target: 1, unit: "", start: "2026-11-01" };

function dataWith(habits, log = {}) {
  const data = emptyData();
  data.habits.push(...[].concat(habits));
  for (const [date, day] of Object.entries(log)) data.log[date] = { ...day };
  return data;
}

const range = (from, n, fn) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`2026-11-${String(from + i).padStart(2, "0")}`, fn(i)]).filter(([, v]) => v));

test("a habit every N days is due only on those days, counted from its start", () => {
  const habit = { ...daily, start: "2026-11-18", every: 3 };
  const data = dataWith(habit, { "2026-11-18": { h: 1 }, "2026-11-21": { h: 1 } });
  assert.equal(isOff(data, habit, "2026-11-19"), true);
  assert.equal(isOff(data, habit, "2026-11-21"), false);
  assert.deepEqual(streak(data, habit, TODAY), { current: 2, best: 2, unit: "day" });
  assert.equal(rate(data, habit, TODAY, 7), 1);
});

test("a break keeps streaks alive, for one habit or all, and avoid habits count through it", () => {
  const weekly = { ...daily, id: "w", type: "weekly", target: 2 };
  const avoid = { ...daily, id: "a", type: "avoid" };
  const data = dataWith([daily, weekly, avoid], { "2026-11-09": { h: 1, w: 2 }, "2026-11-23": { h: 1, w: 2 } });
  for (let d = 1; d <= 8; d++) data.log[`2026-11-0${d}`] = { h: 1 };
  assert.equal(streak(data, daily, TODAY).current, 1);
  applyOp(data, { t: "pause", pause: { id: "p", from: "2026-11-10", to: "2026-11-22", habitId: "" } });
  assert.equal(streak(data, daily, TODAY).current, 10);
  assert.equal(streak(data, weekly, TODAY).current, 2);
  assert.equal(isOff(data, avoid, "2026-11-15"), false);
  assert.equal(level(data, daily, "2026-11-15", TODAY), "off");
  applyOp(data, { t: "pause", pause: { id: "p", from: "2026-11-10", to: "2026-11-22", habitId: "w" } });
  assert.equal(data.pauses.length, 1);
  assert.equal(streak(data, daily, TODAY).current, 1);
  applyOp(data, { t: "delHabit", id: "w" });
  assert.deepEqual(data.pauses, []);
});

test("notes and the day's mood are stored per day, merge, and go with their habit", () => {
  const data = dataWith(daily);
  applyOp(data, { t: "note", date: TODAY, id: "h", v: "Chapter 3" });
  applyOp(data, { t: "day", date: TODAY, day: { mood: 4, note: "Good one" } });
  assert.equal(data.notes[TODAY].h, "Chapter 3");
  assert.equal(hasData({ ...emptyData(), days: data.days }), true);
  const merged = merge(emptyData(), data);
  assert.deepEqual(merged.days, { [TODAY]: { mood: 4, note: "Good one" } });
  assert.deepEqual(merged.notes, { [TODAY]: { h: "Chapter 3" } });
  applyOp(data, { t: "day", date: TODAY, day: { mood: 0, note: "" } });
  assert.deepEqual(data.days, {});
  applyOp(data, { t: "delHabit", id: "h" });
  assert.deepEqual(data.notes, {});
  assert.equal(queue([{ t: "note", date: TODAY, id: "h", v: "a" }], { t: "note", date: TODAY, id: "h", v: "ab" }).length, 1);
  assert.equal(queue([{ t: "day", date: TODAY, day: { mood: 1 } }], { t: "day", date: TODAY, day: { mood: 2 } }).length, 1);
});

test("a timer counts minutes toward its target like an amount", () => {
  const timer = { ...daily, type: "timer", target: 20 };
  assert.equal(isDone(timer, 19), false);
  assert.equal(isDone(timer, 20), true);
  assert.equal(level(dataWith(timer, { [TODAY]: { h: 10 } }), timer, TODAY, TODAY), 2);
});

test("reordering moves the listed habits first and keeps the rest in place", () => {
  const data = dataWith([{ ...daily, id: "a" }, { ...daily, id: "b" }, { ...daily, id: "c" }]);
  applyOp(data, { t: "order", ids: ["c", "a"] });
  assert.deepEqual(data.habits.map((h) => h.id), ["c", "a", "b"]);
});

test("importing merges into what is there and replays like any edit", () => {
  const base = dataWith(daily, { "2026-11-20": { h: 1 } });
  const incoming = dataWith({ ...daily, id: "n", name: "Run" }, { "2026-11-20": { n: 1 }, "2026-11-21": { h: 1 } });
  const out = replay(base, [{ t: "import", data: incoming }]);
  assert.deepEqual(out.habits.map((h) => h.id), ["h", "n"]);
  assert.deepEqual(out.log, { "2026-11-20": { h: 1, n: 1 }, "2026-11-21": { h: 1 } });
  assert.deepEqual(base.habits.length, 1);
});

test("repeating tasks come due again after today", () => {
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2026-11-15", 2), "2027-01-15");
  assert.equal(nextDue("2026-11-24", "daily", TODAY), "2026-11-25");
  assert.equal(nextDue("2026-11-03", "weekly", TODAY), "2026-12-01");
  assert.equal(nextDue("2026-11-30", "weekly", TODAY), "2026-12-07");
  assert.equal(nextDue("", "monthly", TODAY), "2026-12-24");
});

test("weekday pattern shows which days a habit gets done", () => {
  const data = dataWith(daily, range(1, 23, (i) => (new Date(Date.UTC(2026, 10, 1 + i)).getUTCDay() === 0 ? null : { h: 1 })));
  const pattern = weekdayPattern(data, daily, TODAY);
  assert.equal(pattern[0], 1);
  assert.equal(pattern[6], 0);
  assert.equal(pattern[1], 1); // today, a Tuesday, is still open and left out
});

test("correlations find habits done on the same days", () => {
  const a = { ...daily, id: "a", name: "Run" };
  const b = { ...daily, id: "b", name: "Stretch" };
  const c = { ...daily, id: "c", name: "Read" };
  const data = dataWith([a, b, c], range(1, 23, (i) => ({ ...(i % 2 ? { a: 1, b: 1 } : {}), ...(i % 3 ? { c: 1 } : {}) })));
  const found = correlations(data, [a, b, c], TODAY);
  assert.equal(found.length, 1);
  assert.deepEqual([found[0].a.id, found[0].b.id, found[0].withA, found[0].withoutA], ["a", "b", 1, 0]);
  assert.equal(Math.round(found[0].phi), 1);
});

test("mood links compare the mood on done and missed days", () => {
  const data = dataWith(daily, range(1, 23, (i) => (i % 2 ? { h: 1 } : null)));
  for (let i = 0; i < 23; i++) data.days[`2026-11-${String(1 + i).padStart(2, "0")}`] = { mood: i % 2 ? 4 : 2 };
  const [link] = moodLinks(data, [daily], TODAY);
  assert.deepEqual([link.done, link.missed, link.diff], [4, 2, 2]);
});

test("the week review counts what was due and done, and the year recap totals the year", () => {
  const weekly = { ...daily, id: "w", type: "weekly", target: 3 };
  const pages = { ...daily, id: "p", type: "amount", target: 10, unit: "pages" };
  const data = dataWith([daily, weekly, pages], {
    "2026-11-16": { h: 1, w: 1, p: 10 },
    "2026-11-17": { h: 1, w: 1, p: 4 },
    "2026-11-20": { h: 1 },
  });
  data.tasks.push({ id: "t", title: "x", done: "2026-11-18" });
  data.days["2026-11-16"] = { mood: 5 };
  const week = weekReview(data, [daily, weekly, pages], "2026-11-16", TODAY);
  assert.deepEqual(week.rows.map((r) => [r.habit.id, r.done, r.due]), [["h", 3, 7], ["w", 2, 3], ["p", 1, 7]]);
  assert.deepEqual([week.done, week.due, week.tasksDone, week.mood], [6, 17, 1, 5]);
  const year = yearRecap(data, [daily, weekly, pages], 2026, TODAY);
  assert.deepEqual([year.checkins, year.activeDays, year.tasksDone, year.top.habit.id, year.top.days], [7, 3, 1, "h", 3]);
  assert.deepEqual(year.totals.map((x) => [x.habit.id, x.total]), [["p", 14]]);
  assert.deepEqual([year.streak.habit.id, year.streak.count], ["h", 2]);
});

test("the calendar file has a repeating event per habit and an all-day one per dated task", () => {
  const data = dataWith([
    { ...daily, days: [0, 2], time: "07:30" },
    { ...daily, id: "e", name: "Water; plants, all", every: 3 },
    { ...daily, id: "a", type: "avoid", name: "No sugar" },
    { ...daily, id: "w", type: "weekly", name: "Gym", target: 3 },
  ]);
  data.tasks.push({ id: "t", title: "Pay rent", due: "2026-12-01", done: "" }, { id: "u", title: "No date", due: "", done: "" });
  const ics = toIcs(data, new Date(Date.UTC(2026, 10, 24, 12)));
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART:20261102T073000\r\nDURATION:PT15M\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE/);
  assert.match(ics, /SUMMARY:Water\\; plants\\, all\r\nDTSTART;VALUE=DATE:20261101\r\nDTEND;VALUE=DATE:20261102\r\nRRULE:FREQ=DAILY;INTERVAL=3/);
  assert.match(ics, /SUMMARY:Gym\r\n[^]*?RRULE:FREQ=WEEKLY\r\n/);
  assert.match(ics, /UID:task-t@habit-tracker\r\nDTSTAMP:20261124T120000Z\r\nSUMMARY:Pay rent\r\nDTSTART;VALUE=DATE:20261201/);
  assert.equal(ics.includes("No sugar") || ics.includes("No date"), false);
  assert.equal(ics.split("\r\n").every((line) => new TextEncoder().encode(line).length <= 75), true);
});

test("CSV import reads a column per habit or a row per entry, and matches habits by name", () => {
  assert.deepEqual(parseCsv('a,"b ""c"", d"\r\n1,2\n'), [["a", 'b "c", d'], ["1", "2"]]);
  let n = 0;
  const env = { uid: () => `new${n++}`, today: TODAY };
  const wide = fromCsv("Date,Read,Pages\n2026-11-20,1,12\n2026-11-21,0,30\n2026-12-25,1,1\n", dataWith(daily), env);
  assert.deepEqual(wide.habits.map((h) => [h.id, h.name, h.type, h.start]), [["new0", "Pages", "amount", "2026-11-20"]]);
  assert.deepEqual(wide.log, { "2026-11-20": { h: 1, new0: 12 }, "2026-11-21": { new0: 30 } });
  const long = fromCsv("date,habit,value\n2026/11/3,Run,yes\n2026-11-04,Run,\n", emptyData(), env);
  assert.deepEqual(long.log, { "2026-11-03": { new1: 1 } });
  const loop = fromCsv("Date,Read\n2026-11-20,2\n2026-11-21,3\n2026-11-22,1\n", dataWith(daily), env);
  assert.deepEqual([loop.log, loop.skips, loop.habits], [{ "2026-11-20": { h: 1 } }, { "2026-11-21": { h: 1 } }, []]);
  assert.throws(() => fromCsv("a,b\n1,2\n", emptyData(), env), { code: "errImport" });
});

test("JSON import takes a downloaded file and rejects anything else", () => {
  const data = dataWith(daily, { [TODAY]: { h: 1 } });
  assert.deepEqual(fromJson(JSON.stringify(data)), normalize(data));
  assert.throws(() => fromJson("[1]"), { code: "errImport" });
  assert.throws(() => fromJson("nope"), { code: "errImport" });
});

test("a share shows streaks and recent days, and nothing of notes, amounts or tasks", async () => {
  const { buildShare, SHARED_WEEKS } = await import("../src/extras.js");
  const pages = { ...daily, id: "p", type: "amount", target: 10, unit: "pages" };
  const data = dataWith([daily, pages], { "2026-11-23": { h: 1, p: 12 }, [TODAY]: { h: 1 } });
  data.notes[TODAY] = { h: "private" };
  data.tasks.push({ id: "t", title: "private task", done: "" });
  const shared = buildShare(data, [daily], TODAY);
  assert.deepEqual(shared.habits.map((h) => [h.name, h.avoid, h.streak.current, h.cells.length]), [["Read", false, 2, SHARED_WEEKS * 7]]);
  assert.deepEqual(shared.habits[0].cells.slice(-7), [4, 4, null, null, null, null, null]);
  assert.equal(JSON.stringify(shared).includes("private"), false);
});

test("recovery keys are easy to copy, and a sealed passphrase opens only with its key", async () => {
  const { newRecoveryCode, cleanCode, formatCode } = await import("../src/extras.js");
  const { wrap, unwrap } = await import("../src/crypto.js");
  const code = newRecoveryCode();
  assert.match(formatCode(code), /^([A-HJKMNP-TV-Z2-9]{4}-){5}[A-HJKMNP-TV-Z2-9]{4}$/);
  assert.equal(cleanCode(` ${formatCode(code).toLowerCase()} `), code);
  assert.notEqual(newRecoveryCode(), code);
  const sealed = await wrap("correct horse battery", code);
  assert.equal(await unwrap(sealed, code), "correct horse battery");
  await assert.rejects(unwrap(sealed, newRecoveryCode()), { name: "OperationError" });
});

test("reminder times become minutes of the UTC day", async () => {
  const { utcMinutes } = await import("../src/extras.js");
  const now = new Date(2026, 10, 24, 12);
  const offset = new Date(2026, 10, 24, 7, 30).getTimezoneOffset();
  assert.deepEqual(utcMinutes(["07:30", "07:30"], now), [(((450 + offset) % 1440) + 1440) % 1440]);
  assert.equal(utcMinutes(["21:00", "06:15", "23:59"], now).length, 3);
});

test("CSV import reads check-in logs and exports that mark each entry completed or skipped", () => {
  let n = 0;
  const env = { uid: () => `x${n++}`, today: TODAY };
  const log = fromCsv("Habit,Date,Habit ID\nRun,2026-11-20,abc\nRun,2026-11-21,abc\n", emptyData(), env);
  assert.deepEqual(log.log, { "2026-11-20": { x0: 1 }, "2026-11-21": { x0: 1 } });
  const typed = fromCsv(
    "task_id,title,entry_type,entry_date,quantity\n1,Run,completed_manually,20261120,0.0\n1,Run,missed_auto,20261121,0.0\n1,Run,skipped_manually,20261122,0.0\n",
    emptyData(),
    env,
  );
  assert.deepEqual([typed.log, typed.skips], [{ "2026-11-20": { x1: 1 } }, { "2026-11-22": { x1: 1 } }]);
});
