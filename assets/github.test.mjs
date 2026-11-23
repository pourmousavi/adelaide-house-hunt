import { test } from "node:test";
import assert from "node:assert/strict";
import { updateJson, encodeB64 } from "./github.js";

test("updateJson re-reads and retries after a 409, and reads with no-store", async () => {
  let file = { sha: "a", data: [1] }, puts = 0;
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push(init.cache);
    if (!init.method) return new Response(JSON.stringify({ sha: file.sha, encoding: "base64", content: encodeB64(JSON.stringify(file.data)) }));
    const body = JSON.parse(init.body);
    if (++puts === 1) { file = { sha: "b", data: [1, 2] }; return new Response(JSON.stringify({ message: "does not match" }), { status: 409 }); } // someone saved first
    assert.equal(body.sha, "b");
    return new Response("{}");
  };
  const r = await updateJson("o/r", "t", "data/manual.json", [], (list) => ({ data: [...list, 3], message: "m" }));
  assert.deepEqual(r.data, [1, 2, 3], "re-applied on the fresh copy");
  assert.equal(puts, 2);
  assert.ok(seen.every((c) => c === "no-store"));
});
