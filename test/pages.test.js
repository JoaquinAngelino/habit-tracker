import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { API } from "../src/server.js";

const policy = (page) => {
  const html = readFileSync(new URL(`../${page}`, import.meta.url), "utf8");
  const content = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1] ?? "";
  return Object.fromEntries(content.split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
};

for (const page of ["index.html", "share.html"]) {
  test(`${page} runs only its own scripts and calls only the services it uses`, () => {
    const csp = policy(page);
    assert.deepEqual(csp["default-src"], ["'self'"]);
    assert.ok(!csp["script-src"].some((v) => ["'unsafe-inline'", "'unsafe-eval'", "*", "https:"].includes(v)));
    assert.ok(csp["connect-src"].includes(API));
    assert.deepEqual([csp["object-src"], csp["base-uri"]], [["'none'"], ["'none'"]]);
  });
}
