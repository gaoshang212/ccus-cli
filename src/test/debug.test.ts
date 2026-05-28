import test from "node:test";
import assert from "node:assert/strict";
import { debugLog, isDebugEnabled, resolveDebugEnabled, setDebugEnabled } from "../lib/debug";

/** 在 stub 内捕获写到 stderr 的内容，断言 debugLog 的门控与格式。 */
function captureStderr(run: () => void): string {
  const original = process.stderr.write;
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

test("resolveDebugEnabled detects flags and env var", () => {
  assert.equal(resolveDebugEnabled(["statusline", "emit"], {}), false);
  assert.equal(resolveDebugEnabled(["statusline", "emit", "--verbose"], {}), true);
  assert.equal(resolveDebugEnabled(["export", "--debug"], {}), true);
  assert.equal(resolveDebugEnabled(["export", "-v"], {}), true);
  assert.equal(resolveDebugEnabled(["export"], { CCUS_DEBUG: "1" }), true);
  assert.equal(resolveDebugEnabled(["export"], { CCUS_DEBUG: "true" }), true);
  assert.equal(resolveDebugEnabled(["export"], { CCUS_DEBUG: "0" }), false);
});

test("debugLog stays silent unless enabled and writes only to stderr", () => {
  setDebugEnabled(false);
  const silent = captureStderr(() => debugLog("scope", "should not appear"));
  assert.equal(silent, "");
  assert.equal(isDebugEnabled(), false);

  setDebugEnabled(true);
  try {
    const out = captureStderr(() => debugLog("statusline", "event computed", { usagePct: 12.3 }));
    assert.match(out, /\[ccus .*\] statusline: event computed/);
    assert.match(out, /"usagePct":12\.3/);
  } finally {
    setDebugEnabled(false);
  }
});
