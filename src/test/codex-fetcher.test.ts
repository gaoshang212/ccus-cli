import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fetchCodexQuota, resolveCodexQuota, readCodexQuotaCacheSync } from "../lib/codex-fetcher";
import type { CodexChildProcess, CodexSpawnFn } from "../lib/codex-fetcher";

/** 临时数据目录，避免污染真实 data-dir。 */
async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * 伪造 codex app-server 子进程：stdin.write 记录消息并交由 onMessage 决定如何回 stdout；
 * emit 经 queueMicrotask 延迟到 fetchCodexQuota 注册完 stdout listener 之后，模拟真实异步 stdio。
 */
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly sent: string[] = [];
  killed = false;
  readonly stdin = {
    write: (chunk: string): boolean => {
      this.sent.push(chunk);
      try {
        const msg = JSON.parse(chunk.trim()) as { id?: number; method: string };
        this.onMessage(msg);
      } catch {
        // 非 JSON 行忽略。
      }
      return true;
    },
  };
  onMessage(_msg: { id?: number; method: string }): void {
    // 默认不响应。
  }
  kill(): void {
    this.killed = true;
  }
}

/** 构造一个按 responder 回放的 RPC 子进程；responder 收到消息后用 emit 推响应行。 */
function rpcChild(responder: (msg: { id?: number; method: string }, emit: (line: string) => void) => void): FakeChild {
  const child = new FakeChild();
  child.onMessage = (msg) => responder(msg, (line) => queueMicrotask(() => child.stdout.emit("data", line)));
  return child;
}

const asChild = (child: FakeChild): CodexChildProcess => child as unknown as CodexChildProcess;

const INIT_RESULT_LINE = (id: number | undefined) => JSON.stringify({ id, result: { codexHome: "/tmp" } }) + "\n";

test("fetchCodexQuota parses primary/secondary usedPercent (camelCase) and resetsAt seconds", async () => {
  const child = rpcChild((msg, emit) => {
    if (msg.method === "initialize") {
      emit(INIT_RESULT_LINE(msg.id));
    } else if (msg.method === "account/rateLimits/read") {
      emit(
        JSON.stringify({
          id: msg.id,
          result: { rateLimits: { primary: { usedPercent: 42, resetsAt: 1730947200 }, secondary: { usedPercent: 18 } } },
        }) + "\n",
      );
    }
  });
  const spawn: CodexSpawnFn = () => asChild(child);
  const out = await fetchCodexQuota({ spawn, timeoutMs: 1000 });

  assert.equal(out.status, "ok");
  assert.equal(out.fiveHour, 42);
  assert.equal(out.sevenDay, 18);
  assert.equal(out.resetsAt, 1730947200 * 1000);
  // 握手顺序：initialize → initialized 通知 → account/rateLimits/read。
  const methods = child.sent.map((line) => (JSON.parse(line.trim()) as { method: string }).method);
  assert.deepEqual(methods, ["initialize", "initialized", "account/rateLimits/read"]);
});

test("fetchCodexQuota inherits env and sets CODEX_HOME", async () => {
  const child = rpcChild((msg, emit) => {
    if (msg.method === "initialize") {
      emit(INIT_RESULT_LINE(msg.id));
    } else if (msg.method === "account/rateLimits/read") {
      emit(JSON.stringify({ id: msg.id, result: { rateLimits: { primary: { usedPercent: 1 } } } }) + "\n");
    }
  });
  const captured: { env?: NodeJS.ProcessEnv } = {};
  const spawn: CodexSpawnFn = (_cmd, _args, opts) => {
    captured.env = opts.env;
    return asChild(child);
  };
  await fetchCodexQuota({
    env: { HTTPS_PROXY: "http://127.0.0.1:7890", PATH: "/usr/bin" },
    codexHomePath: "/tmp/codex-home",
    spawn,
    timeoutMs: 1000,
  });

  assert.equal(captured.env?.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.equal(captured.env?.CODEX_HOME, "/tmp/codex-home");
});

test("fetchCodexQuota returns unavailable on ENOENT", async () => {
  const child = new FakeChild();
  const spawn: CodexSpawnFn = () => {
    queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn enoent"), { code: "ENOENT" })));
    return asChild(child);
  };
  const out = await fetchCodexQuota({ spawn, timeoutMs: 1000 });

  assert.equal(out.status, "unavailable");
  assert.equal(out.fiveHour, null);
  assert.equal(out.sevenDay, null);
});

test("fetchCodexQuota returns error on timeout when server never replies", async () => {
  const child = new FakeChild();
  const spawn: CodexSpawnFn = () => asChild(child);
  const out = await fetchCodexQuota({ spawn, timeoutMs: 50 });

  assert.equal(out.status, "error");
  assert.equal(child.killed, true);
});

test("fetchCodexQuota tolerates missing usedPercent in one window", async () => {
  const child = rpcChild((msg, emit) => {
    if (msg.method === "initialize") {
      emit(INIT_RESULT_LINE(msg.id));
    } else if (msg.method === "account/rateLimits/read") {
      emit(
        JSON.stringify({
          id: msg.id,
          result: { rateLimits: { primary: { resetsAt: 1730947200 }, secondary: { usedPercent: 18 } } },
        }) + "\n",
      );
    }
  });
  const out = await fetchCodexQuota({ spawn: () => asChild(child), timeoutMs: 1000 });

  assert.equal(out.status, "ok");
  assert.equal(out.fiveHour, null);
  assert.equal(out.sevenDay, 18);
});

test("fetchCodexQuota parses snake_case used_percentage / reset_at fallback", async () => {
  const child = rpcChild((msg, emit) => {
    if (msg.method === "initialize") {
      emit(INIT_RESULT_LINE(msg.id));
    } else if (msg.method === "account/rateLimits/read") {
      emit(
        JSON.stringify({
          id: msg.id,
          result: { rateLimits: { primary: { used_percentage: 55, reset_at: 1730947200 }, secondary: { used_percentage: 33 } } },
        }) + "\n",
      );
    }
  });
  const out = await fetchCodexQuota({ spawn: () => asChild(child), timeoutMs: 1000 });

  assert.equal(out.fiveHour, 55);
  assert.equal(out.sevenDay, 33);
  assert.equal(out.resetsAt, 1730947200 * 1000);
});

test("fetchCodexQuota clamps usedPercent to 0-100", async () => {
  const child = rpcChild((msg, emit) => {
    if (msg.method === "initialize") {
      emit(INIT_RESULT_LINE(msg.id));
    } else if (msg.method === "account/rateLimits/read") {
      emit(JSON.stringify({ id: msg.id, result: { rateLimits: { primary: { usedPercent: 150 }, secondary: { usedPercent: -5 } } } }) + "\n");
    }
  });
  const out = await fetchCodexQuota({ spawn: () => asChild(child), timeoutMs: 1000 });

  assert.equal(out.fiveHour, 100);
  assert.equal(out.sevenDay, 0);
});

test("fetchCodexQuota returns error when rateLimits/read reports rpc error", async () => {
  const child = rpcChild((msg, emit) => {
    if (msg.method === "initialize") {
      emit(INIT_RESULT_LINE(msg.id));
    } else if (msg.method === "account/rateLimits/read") {
      emit(JSON.stringify({ id: msg.id, error: { code: -1, message: "Not initialized" } }) + "\n");
    }
  });
  const out = await fetchCodexQuota({ spawn: () => asChild(child), timeoutMs: 1000 });

  assert.equal(out.status, "error");
});

test("resolveCodexQuota serves cache within ttl without spawning", async () => {
  const dir = await mkdtemp("ccus-codex-cache-");
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return { fiveHour: 1, sevenDay: 2, resetsAt: null, status: "ok" as const };
  };
  const now = new Date("2026-07-27T10:00:00Z");
  const q1 = await resolveCodexQuota(dir, { now, fetcher });
  const q2 = await resolveCodexQuota(dir, { now, fetcher });

  assert.equal(calls, 1);
  assert.deepEqual(q1, { fiveHour: 1, sevenDay: 2, resetsAt: null });
  assert.deepEqual(q2, { fiveHour: 1, sevenDay: 2, resetsAt: null });
});

test("resolveCodexQuota refetches after ttl expires", async () => {
  const dir = await mkdtemp("ccus-codex-cache-");
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return { fiveHour: 1, sevenDay: 2, resetsAt: null, status: "ok" as const };
  };
  const t0 = new Date("2026-07-27T10:00:00Z");
  await resolveCodexQuota(dir, { now: t0, fetcher });
  const later = new Date("2026-07-27T10:06:00Z"); // +6 分钟 > 5 分钟 TTL
  await resolveCodexQuota(dir, { now: later, fetcher });

  assert.equal(calls, 2);
});

test("resolveCodexQuota falls back to stale cache when fetch fails", async () => {
  const dir = await mkdtemp("ccus-codex-cache-");
  const ok = async () => ({ fiveHour: 10, sevenDay: 20, resetsAt: null, status: "ok" as const });
  const unavailable = async () => ({ fiveHour: null, sevenDay: null, resetsAt: null, status: "unavailable" as const });
  const t0 = new Date("2026-07-27T10:00:00Z");
  await resolveCodexQuota(dir, { now: t0, fetcher: ok });
  const later = new Date("2026-07-27T10:06:00Z");
  const q = await resolveCodexQuota(dir, { now: later, fetcher: unavailable });

  assert.deepEqual(q, { fiveHour: 10, sevenDay: 20, resetsAt: null });
});

test("resolveCodexQuota returns null when fetch fails and no cache", async () => {
  const dir = await mkdtemp("ccus-codex-cache-");
  const unavailable = async () => ({ fiveHour: null, sevenDay: null, resetsAt: null, status: "unavailable" as const });
  const q = await resolveCodexQuota(dir, { fetcher: unavailable });

  assert.equal(q, null);
});

test("resolveCodexQuota skips persisting when fetch ok but both windows null", async () => {
  const dir = await mkdtemp("ccus-codex-cache-");
  const empty = async () => ({ fiveHour: null, sevenDay: null, resetsAt: null, status: "ok" as const });
  const q = await resolveCodexQuota(dir, { fetcher: empty });

  assert.equal(q, null);
  assert.equal(readCodexQuotaCacheSync(dir), null);
});
