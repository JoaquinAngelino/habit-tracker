import { test } from "node:test";
import assert from "node:assert/strict";
import { t, setLanguage, STRINGS } from "../src/i18n.js";

test("t picks singular or plural forms and fills placeholders", () => {
  setLanguage("es");
  assert.equal(t("day", { count: 1 }), "1 día");
  assert.equal(t("day", { count: 3 }), "3 días");
  assert.equal(t("daysLeft", { count: 1 }), "Queda 1 día");
  assert.equal(t("streak", { units: t("week", { count: 2 }) }), "Racha de 2 semanas");
  setLanguage("en");
  assert.equal(t("habits", { count: 2 }), "2 habits");
  assert.equal(t("habits"), "Habits");
  assert.equal(t("missingKey"), "missingKey");
});

test("every string exists in both languages with the same placeholders", () => {
  const names = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  assert.deepEqual(Object.keys(STRINGS.es).sort(), Object.keys(STRINGS.en).sort());
  for (const [key, en] of Object.entries(STRINGS.en)) assert.deepEqual(names(STRINGS.es[key]), names(en), key);
});
