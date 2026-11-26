import { addDays, weekday, isAmount } from "./lib.js";

const BYDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const compact = (iso) => iso.replaceAll("-", "");
const text = (value) => String(value).replace(/\\/g, "\\\\").replace(/([;,])/g, "\\$1").replace(/\r\n|\r|\n/g, "\\n");

// Data can come from an imported or synced file, so anything written outside SUMMARY is checked first:
// a stray line break there would add lines of its own to the calendar.
const isDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const timeOf = (value) => (typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : "");
const idOf = (value) => String(value).replace(/[^\w-]/g, "");
const weekdays = (habit) => (Array.isArray(habit.days) ? habit.days.filter((d) => Number.isInteger(d) && d >= 0 && d < 7) : []);
const interval = (habit) => (Number.isInteger(habit.every) && habit.every > 1 && habit.every < 1000 ? habit.every : 0);

// Lines longer than 75 bytes continue on the next one after a space.
function fold(line) {
  const out = [];
  let part = "";
  let size = 0;
  for (const ch of line) {
    const bytes = new TextEncoder().encode(ch).length;
    if (size + bytes > 74) {
      out.push(part);
      part = " ";
      size = 1;
    }
    part += ch;
    size += bytes;
  }
  out.push(part);
  return out.join("\r\n");
}

function rule(habit) {
  if (habit.type === "weekly") return "FREQ=WEEKLY";
  if (habit.type === "monthly") return "FREQ=MONTHLY";
  if (interval(habit)) return `FREQ=DAILY;INTERVAL=${interval(habit)}`;
  if (weekdays(habit).length) return `FREQ=WEEKLY;BYDAY=${weekdays(habit).map((d) => BYDAY[d]).join(",")}`;
  return "FREQ=DAILY";
}

// The first day the rule lands on, which a calendar needs as the event's start.
function firstDay(habit) {
  let d = habit.start;
  const days = weekdays(habit);
  if ((habit.type === "check" || isAmount(habit)) && !interval(habit) && days.length) {
    while (!days.includes(weekday(d))) d = addDays(d, 1);
  }
  return d;
}

function when(date, time) {
  time = timeOf(time);
  if (!time) return [`DTSTART;VALUE=DATE:${compact(date)}`, `DTEND;VALUE=DATE:${compact(addDays(date, 1))}`];
  return [`DTSTART:${compact(date)}T${time.replace(":", "")}00`, "DURATION:PT15M"];
}

// Habits as repeating events and open tasks with a due date as all-day ones. Avoid habits have nothing to schedule.
export function toIcs(data, now = new Date()) {
  const stamp = `${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Habit Tracker//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Habit Tracker"];
  const event = (uid, summary, body) => lines.push("BEGIN:VEVENT", `UID:${uid}@habit-tracker`, `DTSTAMP:${stamp}`, `SUMMARY:${text(summary)}`, ...body, "TRANSP:TRANSPARENT", "END:VEVENT");
  for (const habit of data.habits) {
    if (habit.archived || habit.type === "avoid" || !isDate(habit.start) || !habit.name?.trim?.()) continue;
    event(`habit-${idOf(habit.id)}`, habit.name.trim(), [...when(firstDay(habit), habit.time), `RRULE:${rule(habit)}`]);
  }
  for (const task of data.tasks) {
    if (task.done || !isDate(task.due) || !task.title?.trim?.()) continue;
    event(`task-${idOf(task.id)}`, task.title.trim(), when(task.due));
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
