import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const startApi = await readFile(new URL("../src/python/startKasaApi.py", import.meta.url), "utf8");

test("the Kasa helper binds to loopback only", () => {
  assert.match(startApi, /host="127\.0\.0\.1"/);
  assert.doesNotMatch(startApi, /host="0\.0\.0\.0"/);
});
