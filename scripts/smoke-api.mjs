// API 模式 smoke。两种模式：
//  - mock（默认，不带环境变量）：起本地 mock 模拟智谱样例，离线验证 zhipu preset + custom extractor 两条路径，断言固定。
//  - 真实（设了 CCUS_SMOKE_URL）：用你给的真实配置打真实接口，验证能不能调通、真实额度是多少。仅断言「api test 成功」。
//
// 真实模式环境变量：
//   CCUS_SMOKE_URL           接口地址（必填）
//   CCUS_SMOKE_TOKEN         api key（必填，会写进临时 data-dir 的配置，用完即删）
//   CCUS_SMOKE_PROVIDER      zhipu | custom（默认 zhipu）
//   CCUS_SMOKE_PROJECT       zhipu 的 bigmodel-project
//   CCUS_SMOKE_ORG           zhipu 的 bigmodel-organization
//   CCUS_SMOKE_HEADERS       custom 的额外 header，分号分隔，值支持 {{token}}
//   CCUS_SMOKE_EXTRACTOR_FILE custom 的 extractor 脚本文件
//   CCUS_SMOKE_UA            自定义 User-Agent（遇反爬虫空响应时改成浏览器 UA）
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fails = [];
const expect = (cond, msg) => {
  if (!cond) fails.push(msg);
};

const run = (args, env = process.env) =>
  new Promise((resolve) => {
    const r = { stdout: "", stderr: "", status: null };
    const p = spawn("node", ["dist/cli.js", ...args], { cwd: process.cwd(), env });
    p.stdout.on("data", (d) => {
      r.stdout += d;
    });
    p.stderr.on("data", (d) => {
      r.stderr += d;
    });
    p.on("close", (code) => {
      r.status = code;
      r.stdout = r.stdout.trim();
      r.stderr = r.stderr.trim();
      resolve(r);
    });
  });

// ── 真实模式：用环境变量配置打真实接口 ──
async function runReal() {
  const url = process.env.CCUS_SMOKE_URL;
  const token = process.env.CCUS_SMOKE_TOKEN;
  const provider = process.env.CCUS_SMOKE_PROVIDER === "custom" ? "custom" : "zhipu";
  if (!url) {
    console.error("真实模式需要 CCUS_SMOKE_URL（接口地址）");
    process.exit(1);
  }
  if (!token) {
    console.error("真实模式需要 CCUS_SMOKE_TOKEN（api key，仅写入临时目录、用完即删）");
    process.exit(1);
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccus-smoke-real-"));
  const configArgs = ["api", "config", "--enable", "--provider", provider, "--url", url, "--token", token, "--data-dir", dataDir];
  if (process.env.CCUS_SMOKE_UA) {
    configArgs.push("--user-agent", process.env.CCUS_SMOKE_UA);
  }
  if (provider === "zhipu") {
    if (process.env.CCUS_SMOKE_PROJECT) {
      configArgs.push("--project", process.env.CCUS_SMOKE_PROJECT);
    }
    if (process.env.CCUS_SMOKE_ORG) {
      configArgs.push("--organization", process.env.CCUS_SMOKE_ORG);
    }
  } else {
    if (process.env.CCUS_SMOKE_HEADERS) {
      configArgs.push("--header", process.env.CCUS_SMOKE_HEADERS);
    }
    if (process.env.CCUS_SMOKE_EXTRACTOR_FILE) {
      configArgs.push("--extractor-file", process.env.CCUS_SMOKE_EXTRACTOR_FILE);
    }
  }
  await run(configArgs);
  console.log(`真实模式：provider=${provider}  url=${url}\n`);

  const test = await run(["api", "test", "--data-dir", dataDir]);
  console.log("=== api test ===\n" + test.stdout + (test.stderr ? `\n[stderr] ${test.stderr}` : ""));

  const payloadFile = path.join(dataDir, "payload.json");
  fs.writeFileSync(payloadFile, JSON.stringify({ model: { display_name: "GLM" }, workspace: { current_dir: "/tmp/x" } }));
  const emit = await run(["statusline", "emit", "--input", payloadFile, "--data-dir", dataDir]);
  console.log("\n=== statusline ===\n" + emit.stdout);

  fs.rmSync(dataDir, { recursive: true, force: true });

  expect(test.status === 0, "api test 应成功（退出码 0，代表调通并解析出额度）");
  if (fails.length) {
    console.error("\n❌ SMOKE FAIL:\n" + fails.map((m) => "  - " + m).join("\n"));
    process.exit(1);
  }
  console.log("\n✅ SMOKE PASS（真实数据）");
}

// ── mock 模式（默认）：离线验证 zhipu preset + custom extractor ──
async function runMock() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccus-smoke-"));
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      code: 200,
      success: true,
      data: {
        limits: [
          { type: "TOKENS_LIMIT", percentage: 44, nextResetTime: 1 },
          { type: "TOKENS_LIMIT", percentage: 53, nextResetTime: 2 },
        ],
        level: "pro",
      },
    }));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const env = { ...process.env, MYTOKEN: "testtoken" };

  // cc-switch 风格 extractor 脚本：验证兼容（用户从 cc-switch 拿来的脚本不改写即可用）。
  const extractorFile = path.join(dataDir, "extractor.js");
  fs.writeFileSync(extractorFile, `function(response) {
  const limits = response.data.limits;
  const tokenLimits = limits.filter((l) => l.type === "TOKENS_LIMIT");
  tokenLimits.sort((a, b) => a.nextResetTime - b.nextResetTime);
  return [{ used: tokenLimits[0].percentage }, { used: tokenLimits[1].percentage }];
}`);

  await run([
    "api",
    "config",
    "--enable",
    "--provider",
    "custom",
    "--url",
    `http://localhost:${port}/q`,
    "--header",
    "Authorization: {{token}}",
    "--extractor-file",
    extractorFile,
    "--token-env",
    "MYTOKEN",
    "--data-dir",
    dataDir,
  ], env);

  const test = await run(["api", "test", "--data-dir", dataDir], env);
  console.log("api test   :", test.stdout.split("\n").pop());
  expect(test.stdout.includes("5h 44.0%"), "api test 应含 5h 44.0%");
  expect(test.stdout.includes("7d 53.0%"), "api test 应含 7d 53.0%");

  const payloadFile = path.join(dataDir, "payload.json");
  fs.writeFileSync(payloadFile, JSON.stringify({ model: { display_name: "GLM" }, workspace: { current_dir: "/tmp/x" } }));
  const emit = await run(["statusline", "emit", "--input", payloadFile, "--data-dir", dataDir], env);
  console.log("statusline :", emit.stdout);
  expect(emit.stdout.includes("5h 44.0%"), "statusline 应含 5h 44.0%");
  expect(emit.stdout.includes("7d 53.0%"), "statusline 应含 7d 53.0%");

  // zhipu provider（内置 preset）也走同一条 runExtractor 路径，验证 preset 脚本能解析智谱样例
  const dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "ccus-smoke-"));
  await run([
    "api",
    "config",
    "--enable",
    "--provider",
    "zhipu",
    "--url",
    `http://localhost:${port}/q`,
    "--project",
    "p1",
    "--organization",
    "o1",
    "--token-env",
    "MYTOKEN",
    "--data-dir",
    dataDir2,
  ], env);
  const zhipuTest = await run(["api", "test", "--data-dir", dataDir2], env);
  console.log("zhipu test :", zhipuTest.stdout.split("\n").pop());
  expect(zhipuTest.stdout.includes("5h 44.0%"), "zhipu api test 应含 5h 44.0%");
  expect(zhipuTest.stdout.includes("7d 53.0%"), "zhipu api test 应含 7d 53.0%");
  fs.rmSync(dataDir2, { recursive: true, force: true });

  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });

  if (fails.length) {
    console.error("\n❌ SMOKE FAIL:\n" + fails.map((m) => "  - " + m).join("\n"));
    process.exit(1);
  }
  console.log("\n✅ SMOKE PASS");
}

if (process.env.CCUS_SMOKE_URL) {
  await runReal();
} else {
  await runMock();
}
