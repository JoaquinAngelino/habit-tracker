import { $, el, mark } from "./ui.js";
import { t, setLanguage, applyTranslations, streakText } from "./i18n.js";
import { openWithKey } from "./crypto.js";
import { readShare } from "./server.js";
import { local, read, write } from "./storage.js";

// The page a share link opens. The key after the dot never leaves the browser: it is in the part of the address servers do not get.
const FOLLOWING_KEY = "ht.following";
const lang = setLanguage(read(local, "ht.lang") || (navigator.language?.startsWith("es") ? "es" : "en"));
document.documentElement.lang = lang;
applyTranslations();

const percent = (r) => (r == null ? "–" : new Intl.NumberFormat(lang, { style: "percent" }).format(r));

function row(habit) {
  const s = habit.streak;
  return el("article", { class: "item" }, [
    el("div", { class: "item-main" }, [
      el("span", { class: `tape item-tape${s.current ? " is-done" : ""}`, textContent: t(`short_${s.unit}`, { count: s.current }) }),
      el("div", { class: "item-body" }, [
        el("p", { class: "item-title", textContent: habit.name.trim() || t("untitled") }),
        el("p", { class: "item-marks" }, [
          mark(streakText(habit.avoid, s), s.current ? "green" : null),
          mark(t("best", { units: t(s.unit, { count: s.best }) })),
          mark(`${t("last30")}: ${percent(habit.rate)}`),
        ]),
      ]),
    ]),
    el("div", { class: "heatmap-wrap" }, [el("div", { class: "heatmap" }, habit.cells.map((lvl) => el("span", { class: "cell", "data-level": lvl ?? "none" })))]),
  ]);
}

const parse = (text) => (text ?? "").split(",").filter((link) => link.includes("."));
const links = () => parse(location.hash.slice(1));

function follow(next) {
  write(local, FOLLOWING_KEY, next.join(","));
  location.hash = next.join(",");
}

async function lane(link) {
  const [token, key] = link.split(".");
  const head = (title, count) => el("div", { class: "lane-head" }, [
    el("h2", { class: "lane-title", textContent: title }),
    count ? el("span", { class: "lane-count", textContent: count }) : null,
    links().length > 1 ? el("span", { class: "lane-tools" }, [el("button", { type: "button", class: "btn-text btn-small", textContent: t("sharedRemove"), onclick: () => follow(links().filter((x) => x !== link)) })]) : null,
  ]);
  try {
    const shared = JSON.parse(await openWithKey(await readShare(token), key));
    const [y, m, d] = shared.updated.split("-").map(Number);
    const date = new Intl.DateTimeFormat(lang, { month: "long", day: "numeric" }).format(new Date(y, m - 1, d));
    return el("section", { class: "lane", "data-tone": "green" }, [head(shared.name || t("sharedTitle"), t("sharedUpdated", { date })), el("div", { class: "rows" }, shared.habits.map(row))]);
  } catch {
    return el("section", { class: "lane", "data-tone": "muted" }, [head(t("sharedTitle")), el("div", { class: "rows" }, [el("p", { class: "lane-empty", textContent: t("sharedGone") })])]);
  }
}

function followBox() {
  const input = el("input", { placeholder: t("sharedFollow"), "aria-label": t("sharedFollow"), spellcheck: false, autocomplete: "off" });
  const add = () => {
    const [link] = parse(input.value.trim().split("#").pop());
    if (link && !links().includes(link)) follow([...links(), link]);
  };
  return el("section", { class: "lane", "data-tone": "blue" }, [
    el("div", { class: "lane-head" }, [el("h2", { class: "lane-title", textContent: t("sharedFollow") })]),
    el("div", { class: "rows" }, [el("div", { class: "item" }, [el("p", { class: "hint", textContent: t("sharedFollowHint") }), el("div", { class: "row" }, [input, el("button", { type: "button", class: "btn", textContent: t("sharedAdd"), onclick: add })])])]),
  ]);
}

async function render() {
  $("#view").replaceChildren(...(await Promise.all(links().map(lane))), followBox());
}

// A link just opened joins the ones this browser already follows.
const saved = parse(read(local, FOLLOWING_KEY));
const opened = links();
if (saved.some((link) => !opened.includes(link))) history.replaceState(null, "", `#${[...saved, ...opened.filter((link) => !saved.includes(link))].join(",")}`);
if (opened.some((link) => !saved.includes(link))) write(local, FOLLOWING_KEY, links().join(","));
window.addEventListener("hashchange", render);
await render();
