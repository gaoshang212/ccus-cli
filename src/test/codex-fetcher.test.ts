import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fetchCodexQuota, fetchCodexQuotaViaWham, parseWhamUsage, readCodexAuth, readCodexQuotaCacheSync, resolveCodexQuota } from "../lib/codex-fetcher";
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

test("fetchCodexQuota classifies windows by windowDurationMins regardless of primary/secondary order", async () => {
  // 实测 app-server 可能把周额度放 primary、5h 放 secondary（这正是 ccus 旧硬映射 7d 恒 null 的根因）。
  const child = rpcChild((msg, emit) => {
    if (msg.method === "initialize") {
      emit(INIT_RESULT_LINE(msg.id));
    } else if (msg.method === "account/rateLimits/read") {
      emit(
        JSON.stringify({
          id: msg.id,
          result: {
            rateLimits: {
              primary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1730947200 },
              secondary: { usedPercent: 60, windowDurationMins: 300 },
            },
          },
        }) + "\n",
      );
    }
  });
  const out = await fetchCodexQuota({ spawn: () => asChild(child), timeoutMs: 1000 });

  assert.equal(out.status, "ok");
  assert.equal(out.fiveHour, 60);
  assert.equal(out.sevenDay, 4);
  assert.equal(out.resetsAt, 1730947200 * 1000);
});

test("fetchCodexQuota maps a lone weekly window to sevenDay with fiveHour null", async () => {
  // 只有周窗（primary，duration=10080）、没有 5h 窗：fiveHour 应为 null，sevenDay 取该窗。
  const child = rpcChild((msg, emit) => {
    if (msg.method === "initialize") {
      emit(INIT_RESULT_LINE(msg.id));
    } else if (msg.method === "account/rateLimits/read") {
      emit(
        JSON.stringify({
          id: msg.id,
          result: { rateLimits: { primary: { usedPercent: 4, windowDurationMins: 10080 } } },
        }) + "\n",
      );
    }
  });
  const out = await fetchCodexQuota({ spawn: () => asChild(child), timeoutMs: 1000 });

  assert.equal(out.status, "ok");
  assert.equal(out.fiveHour, null);
  assert.equal(out.sevenDay, 4);
});

test("fetchCodexQuota falls back to legacy primary/secondary mapping when duration is unknown", async () => {
  // duration 都是无法归类的时长（60/120），退回 legacy：primary→5h、secondary→7d。
  const child = rpcChild((msg, emit) => {
    if (msg.method === "initialize") {
      emit(INIT_RESULT_LINE(msg.id));
    } else if (msg.method === "account/rateLimits/read") {
      emit(
        JSON.stringify({
          id: msg.id,
          result: {
            rateLimits: {
              primary: { usedPercent: 42, windowDurationMins: 60 },
              secondary: { usedPercent: 18, windowDurationMins: 120 },
            },
          },
        }) + "\n",
      );
    }
  });
  const out = await fetchCodexQuota({ spawn: () => asChild(child), timeoutMs: 1000 });

  assert.equal(out.fiveHour, 42);
  assert.equal(out.sevenDay, 18);
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
  const whamUnavailable = async () => ({ fiveHour: null, sevenDay: null, resetsAt: null, status: "error" as const });
  const t0 = new Date("2026-07-27T10:00:00Z");
  await resolveCodexQuota(dir, { now: t0, fetcher: ok });
  const later = new Date("2026-07-27T10:06:00Z");
  const q = await resolveCodexQuota(dir, { now: later, fetcher: unavailable, whamFetcher: whamUnavailable });

  assert.deepEqual(q, { fiveHour: 10, sevenDay: 20, resetsAt: null });
});

test("resolveCodexQuota returns null when fetch fails and no cache", async () => {
  const dir = await mkdtemp("ccus-codex-cache-");
  const unavailable = async () => ({ fiveHour: null, sevenDay: null, resetsAt: null, status: "unavailable" as const });
  const whamUnavailable = async () => ({ fiveHour: null, sevenDay: null, resetsAt: null, status: "error" as const });
  const q = await resolveCodexQuota(dir, { fetcher: unavailable, whamFetcher: whamUnavailable });

  assert.equal(q, null);
});

test("resolveCodexQuota skips persisting when fetch ok but both windows null", async () => {
  const dir = await mkdtemp("ccus-codex-cache-");
  const empty = async () => ({ fiveHour: null, sevenDay: null, resetsAt: null, status: "ok" as const });
  const q = await resolveCodexQuota(dir, { fetcher: empty });

  assert.equal(q, null);
  assert.equal(readCodexQuotaCacheSync(dir), null);
});

// --- auth.json 读取 ---

/** 造一个临时 CODEX_HOME 并写一份 auth.json。 */
async function makeCodexHome(auth: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-codex-home-"));
  await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify(auth), "utf8");
  return dir;
}

test("readCodexAuth returns token in chatgpt mode", async () => {
  const dir = await makeCodexHome({ auth_mode: "chatgpt", tokens: { access_token: "tok-123", account_id: "acct-1" } });
  try {
    assert.deepEqual(readCodexAuth(dir), { accessToken: "tok-123", accountId: "acct-1" });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("readCodexAuth returns null for api_key mode", async () => {
  const dir = await makeCodexHome({ auth_mode: "apikey", tokens: { access_token: "tok" } });
  try {
    assert.equal(readCodexAuth(dir), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("readCodexAuth returns null when auth.json missing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-codex-home-"));
  try {
    assert.equal(readCodexAuth(dir), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("readCodexAuth returns null when tokens field missing", async () => {
  const dir = await makeCodexHome({ auth_mode: "chatgpt" });
  try {
    assert.equal(readCodexAuth(dir), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("readCodexAuth returns null when access_token blank", async () => {
  const dir = await makeCodexHome({ auth_mode: "chatgpt", tokens: { access_token: "   " } });
  try {
    assert.equal(readCodexAuth(dir), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- wham/usage 解析 ---

test("parseWhamUsage parses both windows by limit_window_seconds", () => {
  const q = parseWhamUsage({
    rate_limit: {
      primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_at: 1730947200 },
      secondary_window: { used_percent: 12, limit_window_seconds: 604800 },
    },
  });
  assert.equal(q.fiveHour, 30);
  assert.equal(q.sevenDay, 12);
  assert.equal(q.resetsAt, 1730947200 * 1000);
});

test("parseWhamUsage classifies regardless of primary/secondary order", () => {
  // secondary_window 是 5h、primary_window 是 7d（顺序互换），仍按 limit_window_seconds 认桶。
  const q = parseWhamUsage({
    rate_limit: {
      primary_window: { used_percent: 12, limit_window_seconds: 604800 },
      secondary_window: { used_percent: 30, limit_window_seconds: 18000 },
    },
  });
  assert.equal(q.fiveHour, 30);
  assert.equal(q.sevenDay, 12);
});

test("parseWhamUsage skips window missing used_percent", () => {
  const q = parseWhamUsage({
    rate_limit: {
      primary_window: { limit_window_seconds: 18000 },
      secondary_window: { used_percent: 12, limit_window_seconds: 604800 },
    },
  });
  assert.equal(q.fiveHour, null);
  assert.equal(q.sevenDay, 12);
});

test("parseWhamUsage returns all null when rate_limit missing", () => {
  assert.deepEqual(parseWhamUsage({}), { fiveHour: null, sevenDay: null, resetsAt: null });
  assert.deepEqual(parseWhamUsage(null), { fiveHour: null, sevenDay: null, resetsAt: null });
});

// --- wham/usage 回退拉取 ---

test("fetchCodexQuotaViaWham returns ok with parsed quota and proper headers", async () => {
  let captured: { url?: string; headers?: Record<string, string> } = {};
  const out = await fetchCodexQuotaViaWham({
    authReader: () => ({ accessToken: "tok", accountId: "acct-1" }),
    httpGet: async (url, opts) => {
      captured = { url, headers: opts.headers };
      return {
        status: 200,
        body: JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 30, limit_window_seconds: 18000 },
            secondary_window: { used_percent: 12, limit_window_seconds: 604800 },
          },
        }),
      };
    },
  });
  assert.equal(out.status, "ok");
  assert.equal(out.fiveHour, 30);
  assert.equal(out.sevenDay, 12);
  assert.equal(captured.url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(captured.headers?.Authorization, "Bearer tok");
  assert.equal(captured.headers?.["User-Agent"], "codex-cli");
  assert.equal(captured.headers?.["ChatGPT-Account-Id"], "acct-1");
});

test("fetchCodexQuotaViaWham returns error when no auth token", async () => {
  const out = await fetchCodexQuotaViaWham({ authReader: () => null });
  assert.equal(out.status, "error");
  assert.equal(out.fiveHour, null);
});

test("fetchCodexQuotaViaWham returns error on HTTP 401", async () => {
  const out = await fetchCodexQuotaViaWham({
    authReader: () => ({ accessToken: "tok", accountId: null }),
    httpGet: async () => ({ status: 401, body: "" }),
  });
  assert.equal(out.status, "error");
});

test("fetchCodexQuotaViaWham returns error on timeout", async () => {
  const out = await fetchCodexQuotaViaWham({
    authReader: () => ({ accessToken: "tok", accountId: null }),
    httpGet: async () => {
      throw new Error("timed out");
    },
  });
  assert.equal(out.status, "error");
});

test("fetchCodexQuotaViaWham returns error on invalid json body", async () => {
  const out = await fetchCodexQuotaViaWham({
    authReader: () => ({ accessToken: "tok", accountId: null }),
    httpGet: async () => ({ status: 200, body: "{not json" }),
  });
  assert.equal(out.status, "error");
});

// --- resolveCodexQuota wham 回退编排 ---

test("resolveCodexQuota falls back to wham when app-server unavailable and wham ok", async () => {
  const dir = await mkdtemp("ccus-codex-wham-");
  const unavailable = async () => ({ fiveHour: null, sevenDay: null, resetsAt: null, status: "unavailable" as const });
  let whamCalls = 0;
  const whamFetcher = async () => {
    whamCalls += 1;
    return { fiveHour: 30, sevenDay: 12, resetsAt: null, status: "ok" as const };
  };
  const q = await resolveCodexQuota(dir, { fetcher: unavailable, whamFetcher });
  assert.deepEqual(q, { fiveHour: 30, sevenDay: 12, resetsAt: null });
  assert.equal(whamCalls, 1);
  assert.equal(readCodexQuotaCacheSync(dir)?.fiveHour, 30); // wham 额度写进缓存
});

test("resolveCodexQuota returns stale cache when both app-server unavailable and wham fail", async () => {
  const dir = await mkdtemp("ccus-codex-wham-");
  const t0 = new Date("2026-07-27T10:00:00Z");
  const ok = async () => ({ fiveHour: 10, sevenDay: 20, resetsAt: null, status: "ok" as const });
  await resolveCodexQuota(dir, { now: t0, fetcher: ok });
  const later = new Date("2026-07-27T10:06:00Z");
  const unavailable = async () => ({ fiveHour: null, sevenDay: null, resetsAt: null, status: "unavailable" as const });
  const whamFail = async () => ({ fiveHour: null, sevenDay: null, resetsAt: null, status: "error" as const });
  const q = await resolveCodexQuota(dir, { now: later, fetcher: unavailable, whamFetcher: whamFail });
  assert.deepEqual(q, { fiveHour: 10, sevenDay: 20, resetsAt: null });
});

test("resolveCodexQuota returns null when unavailable + wham fail + no cache", async () => {
  const dir = await mkdtemp("ccus-codex-wham-");
  const unavailable = async () => ({ fiveHour: null, sevenDay: null, resetsAt: null, status: "unavailable" as const });
  const whamFail = async () => ({ fiveHour: null, sevenDay: null, resetsAt: null, status: "error" as const });
  const q = await resolveCodexQuota(dir, { fetcher: unavailable, whamFetcher: whamFail });
  assert.equal(q, null);
});

test("resolveCodexQuota does not call wham when app-server returns error", async () => {
  const dir = await mkdtemp("ccus-codex-wham-");
  const errorFetch = async () => ({ fiveHour: null, sevenDay: null, resetsAt: null, status: "error" as const });
  let whamCalls = 0;
  const whamFetcher = async () => {
    whamCalls += 1;
    return { fiveHour: 1, sevenDay: 2, resetsAt: null, status: "ok" as const };
  };
  const q = await resolveCodexQuota(dir, { fetcher: errorFetch, whamFetcher });
  assert.equal(q, null);
  assert.equal(whamCalls, 0); // error 不触发 wham
});

test("resolveCodexQuota serves fresh cache without calling app-server or wham", async () => {
  const dir = await mkdtemp("ccus-codex-wham-");
  let fetchCalls = 0;
  let whamCalls = 0;
  const now = new Date("2026-07-27T10:00:00Z");
  await resolveCodexQuota(dir, {
    now,
    fetcher: async () => {
      fetchCalls += 1;
      return { fiveHour: 10, sevenDay: 20, resetsAt: null, status: "ok" as const };
    },
    whamFetcher: async () => {
      whamCalls += 1;
      return { fiveHour: 1, sevenDay: 2, resetsAt: null, status: "ok" as const };
    },
  });
  // 第二次：缓存新鲜，fetcher / wham 都不应被调用。
  const q = await resolveCodexQuota(dir, {
    now,
    fetcher: async () => {
      fetchCalls += 1;
      return { fiveHour: 99, sevenDay: 99, resetsAt: null, status: "ok" as const };
    },
    whamFetcher: async () => {
      whamCalls += 1;
      return { fiveHour: 1, sevenDay: 2, resetsAt: null, status: "ok" as const };
    },
  });
  assert.deepEqual(q, { fiveHour: 10, sevenDay: 20, resetsAt: null });
  assert.equal(fetchCalls, 1);
  assert.equal(whamCalls, 0);
});
