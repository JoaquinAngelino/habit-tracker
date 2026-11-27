const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  x: "M4 4l8 8M12 4l-8 8",
  plus: "M8 3v10M3 8h10",
  minus: "M3 8h10",
  left: "M10 3L5 8l5 5",
  right: "M6 3l5 5-5 5",
  up: "M3 10l5-5 5 5",
  down: "M3 6l5 5 5-5",
};
const TOAST_MS = 6000;

export const $ = (sel) => document.querySelector(sel);

export function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "style") e.style.cssText = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v);
  }
  e.append(...children.filter((c) => c != null && c !== false));
  return e;
}

export const mark = (text, tone) => el("span", { class: "mark", "data-tone": tone, textContent: text });

export function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "icon");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

export function iconButton(name, label, onclick, extra = {}) {
  return el("button", { type: "button", class: "icon-btn", title: label, "aria-label": label, onclick, ...extra }, [icon(name)]);
}

// No empty text: only the heading shows. `title` is text, or a node to put in the heading.
export function lane(tone, title, { count = "", tools = [], rows, empty }) {
  return el("section", { class: "lane", "data-tone": tone }, [
    el("div", { class: "lane-head" }, [
      el("h2", { class: "lane-title" }, [title]),
      count ? el("span", { class: "lane-count", textContent: count }) : null,
      el("span", { class: "lane-tools" }, tools),
    ]),
    el("div", { class: "rows" }, rows.length || empty == null ? rows : [el("p", { class: "lane-empty" }, [].concat(empty))]),
  ]);
}

let toastTimer = null;

function hideToast() {
  clearTimeout(toastTimer);
  $("#toast")?.replaceChildren();
}

// One message at a time, in a live region; it stays while focus is inside it.
export function toast(text, { action, onAction } = {}) {
  const box = $("#toast");
  if (!box) return;
  clearTimeout(toastTimer);
  const button = action
    ? el("button", {
      type: "button",
      class: "toast-action",
      textContent: action,
      onclick: () => {
        hideToast();
        onAction();
      },
    })
    : null;
  // The space keeps a screen reader from running the message into the button's name.
  box.replaceChildren(el("div", { class: "toast-body" }, [el("span", { textContent: text }), button ? " " : null, button]));
  const later = () => {
    toastTimer = setTimeout(() => (box.contains(document.activeElement) ? later() : hideToast()), TOAST_MS);
  };
  later();
}

export function heatmapLegend({ less, more, slip, off }) {
  const swatch = (level) => el("span", { class: "cell", "data-level": level });
  return el("div", { class: "heatmap-legend", "aria-hidden": "true" }, [
    el("span", { textContent: less }),
    ...["0", "1", "2", "3", "4"].map(swatch),
    el("span", { textContent: more }),
    el("span", { class: "legend-item" }, [swatch("-1"), slip]),
    el("span", { class: "legend-item" }, [swatch("off"), off]),
  ]);
}

// Cells run down each week's column.
export function heatmap(cells, { label, hint = "" }) {
  const nodes = cells.map((c) => el("span", { class: "cell", "data-level": c.level ?? "none" }));
  const interactive = cells.some((c) => c.text);
  const grid = el("div", { class: "heatmap", role: interactive ? "group" : "img", "aria-label": label }, nodes);
  if (!interactive) return el("div", { class: "heatmap-wrap" }, [grid]);

  const detail = el("p", { class: "heatmap-detail", "aria-live": "polite", textContent: hint });
  let picked = -1;
  const pick = (i) => {
    if (!cells[i]?.text || i === picked) return;
    nodes[picked]?.removeAttribute("data-picked");
    picked = i;
    nodes[i].setAttribute("data-picked", "");
    detail.textContent = cells[i].text;
  };
  const last = () => cells.findLastIndex((c) => c.text);
  grid.tabIndex = 0;
  grid.addEventListener("focus", () => picked < 0 && pick(last()));
  grid.addEventListener("keydown", (e) => {
    const step = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[e.key];
    if (e.key === "Home") pick(cells.findIndex((c) => c.text));
    else if (e.key === "End") pick(last());
    else if (step) pick(Math.max(0, picked) + step);
    else return;
    e.preventDefault();
    nodes[picked]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
  // Gaps between cells count too, so a finger need not land on a 10px square.
  grid.addEventListener("click", (e) => {
    const first = nodes[0].getBoundingClientRect();
    const pitch = nodes.length > 7 ? nodes[7].getBoundingClientRect().left - first.left : first.width;
    const col = Math.floor((e.clientX - first.left) / pitch);
    const row = Math.floor((e.clientY - first.top) / pitch);
    if (col >= 0 && row >= 0 && row < 7) pick(col * 7 + row);
  });
  return el("div", { class: "heatmap-block" }, [el("div", { class: "heatmap-wrap" }, [grid]), detail]);
}

function svg(tag, attrs = {}) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function chartTable(caption, labels, series, format, summary) {
  return el("details", { class: "chart-table" }, [
    el("summary", { textContent: summary }),
    el("table", {}, [
      el("caption", { textContent: caption }),
      el("thead", {}, [el("tr", {}, [el("th", { scope: "col", textContent: "" }), ...series.map((s) => el("th", { scope: "col", textContent: s.name }))])]),
      el("tbody", {}, labels.map((label, i) => el("tr", {}, [el("th", { scope: "row", textContent: label.long }), ...series.map((s) => el("td", { textContent: s.values[i] == null ? "–" : format(s.values[i]) }))]))),
    ]),
  ]);
}

// Lines over `labels` ({ short, long }), one point per label. The plot stretches with its box while points and text
// stay HTML, so they keep their shape at any width. `tone` names a color token for each series.
export function lineChart({ label, labels, series, format, min = 0, max, tableSummary }) {
  const n = labels.length;
  const top = max ?? Math.max(min + 1, ...series.flatMap((s) => s.values.filter((v) => v != null)));
  const x = (i) => ((i + 0.5) / n) * 100;
  const y = (v) => 100 - ((v - min) / (top - min || 1)) * 100;
  const plot = svg("svg", { class: "chart-plot", viewBox: "0 0 100 100", preserveAspectRatio: "none", "aria-hidden": "true" });
  for (const v of [min, (min + top) / 2, top]) plot.append(svg("line", { class: "chart-grid", x1: 0, x2: 100, y1: y(v), y2: y(v) }));
  const dots = [];
  for (const s of series) {
    let path = "";
    s.values.forEach((v, i) => {
      if (v == null) return;
      path += `${path && s.values[i - 1] != null ? "L" : "M"}${x(i)} ${y(v)}`;
      dots.push(el("span", { class: "chart-dot", "data-tone": s.tone, style: `left:${x(i)}%;top:${y(v)}%` }));
    });
    plot.append(svg("path", { class: "chart-line", "data-tone": s.tone, d: path }));
  }
  const cross = el("span", { class: "chart-cross", hidden: true });
  const tip = el("div", { class: "chart-tip", hidden: true, role: "status" });
  const box = el("div", { class: "chart-box", tabIndex: 0, role: "img", "aria-label": label }, [
    plot,
    ...dots,
    el("span", { class: "chart-y chart-y-top", textContent: format(top) }),
    el("span", { class: "chart-y chart-y-bottom", textContent: format(min) }),
    cross,
    tip,
  ]);
  let at = -1;
  const show = (i) => {
    at = Math.max(0, Math.min(n - 1, i));
    cross.hidden = tip.hidden = false;
    cross.style.left = `${x(at)}%`;
    tip.style.left = `${Math.min(80, Math.max(20, x(at)))}%`;
    tip.replaceChildren(
      el("p", { class: "chart-tip-label", textContent: labels[at].long }),
      ...series.map((s) => el("p", { class: "chart-tip-row" }, [
        el("span", { class: "chart-key", "data-tone": s.tone }),
        el("strong", { textContent: s.values[at] == null ? "–" : format(s.values[at]) }),
        el("span", { textContent: ` ${s.name}` }),
      ])),
    );
  };
  const hide = () => {
    cross.hidden = tip.hidden = true;
  };
  box.addEventListener("pointermove", (e) => {
    const r = box.getBoundingClientRect();
    show(Math.floor(((e.clientX - r.left) / r.width) * n));
  });
  box.addEventListener("pointerleave", () => document.activeElement !== box && hide());
  box.addEventListener("focus", () => show(at < 0 ? n - 1 : at));
  box.addEventListener("blur", hide);
  box.addEventListener("keydown", (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (e.key === "Home") show(0);
    else if (e.key === "End") show(n - 1);
    else if (step) show(at + step);
    else return;
    e.preventDefault();
  });
  const legend = series.length > 1
    ? el("p", { class: "chart-legend" }, series.map((s) => el("span", { class: "legend-item" }, [el("span", { class: "chart-key", "data-tone": s.tone }), s.name])))
    : null;
  return el("figure", { class: "chart" }, [
    legend,
    box,
    el("div", { class: "chart-ticks", "aria-hidden": "true", style: `grid-template-columns:repeat(${n}, minmax(0, 1fr))` }, labels.map((l) => el("span", { textContent: l.short }))),
    chartTable(label, labels, series, format, tableSummary),
  ]);
}

export function columnChart({ label, bars }) {
  const top = Math.max(1, ...bars.map((b) => b.value));
  return el("figure", { class: "columns", role: "img", "aria-label": `${label}: ${bars.map((b) => `${b.label} ${b.value}`).join(", ")}` }, bars.map((b) =>
    el("span", { class: "column", "aria-hidden": "true" }, [
      el("span", { class: "column-value", textContent: String(b.value) }),
      el("span", { class: "column-track" }, [el("span", { class: "column-fill", style: `height:${(b.value / top) * 100}%` })]),
      el("span", { class: "column-label", textContent: b.label }),
    ])));
}
