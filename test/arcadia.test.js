import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runArcadiaMonitor } from "../scripts/arcadia-monitor.js";
import { sendBarkNotification } from "../src/bark.js";
import { withFileStateLock } from "../src/file-state.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "zhixue-arcadia-"));
  const notices = [];
  const logs = [];
  let score = 90;
  let barkStatus = 200;
  const originals = { fetch: globalThis.fetch, log: console.log, warn: console.warn, error: console.error };
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.hostname === "api.day.app") {
      assert.equal(url.pathname, "/push");
      assert.equal(options.method, "POST");
      notices.push(JSON.parse(options.body));
      return Response.json({ code: barkStatus }, { status: barkStatus });
    }
    assert.equal(url.hostname, "www.zhixue.com");
    if (url.pathname === "/container/getCurrentUser") return Response.json({ result: { role: "student" } });
    if (url.pathname === "/container/app/token/getToken") return Response.json({ result: "test-token" });
    if (url.pathname === "/zhixuebao/base/common/academicYear") {
      return Response.json({ result: [{ beginTime: "2026-09-01", endTime: "2027-08-31" }] });
    }
    if (url.pathname === "/zhixuebao/report/exam/getUserExamList") {
      return Response.json({ result: { examList: [{ examId: "exam-1", examName: "月考" }] } });
    }
    if (url.pathname === "/zhixuebao/report/exam/getReportMain") {
      return Response.json({ result: { paperList: [{ paperId: "math", subjectName: "数学", userScore: score }] } });
    }
    throw new Error(`Unexpected path: ${url.pathname}`);
  };
  for (const level of ["log", "warn", "error"]) console[level] = (value) => logs.push(String(value));
  t.after(async () => {
    globalThis.fetch = originals.fetch;
    for (const level of ["log", "warn", "error"]) console[level] = originals[level];
    await rm(directory, { recursive: true, force: true });
  });
  const env = {
    ZHIXUE_COOKIE: "JSESSIONID=test-session",
    BARK: "test-device",
    ZHIXUE_STATE_FILE: join(directory, "snapshot.json"),
  };
  return { env, notices, logs, directory, setScore(value) { score = value; }, setBarkStatus(value) { barkStatus = value; } };
}

test("Arcadia persists a baseline across runs and sends one bounded result notice per run", async (t) => {
  const f = await fixture(t);
  assert.equal(await runArcadiaMonitor(f.env), 0);
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0].title, /Arcadia.*运行成功/);
  assert.match(f.notices[0].body, /首次成绩基线/);
  assert.doesNotMatch(f.notices[0].body, /数学/);
  assert.equal(await runArcadiaMonitor(f.env), 0);
  assert.equal(f.notices.length, 2);
  assert.match(f.notices[1].body, /成绩变化 0 项/);
  f.setScore(95);
  assert.equal(await runArcadiaMonitor(f.env), 0);
  assert.equal(f.notices.length, 3);
  assert.match(f.notices[2].body, /扫描 1 场考试；成绩变化 1 项/);
  assert.match(f.notices[2].body, /月考 \/ 数学: 90 → 95/);
  const saved = JSON.parse(await readFile(f.env.ZHIXUE_STATE_FILE, "utf8"));
  assert.equal(saved.grades["exam-1"].subjects.math.score, 95);
  assert.equal((await stat(f.env.ZHIXUE_STATE_FILE)).mode & 0o777, 0o600);
  assert.equal(f.logs.some((line) => /test-device|test-session/.test(line)), false);
});

test("failed change notifications preserve the snapshot so the next run retries", async (t) => {
  const f = await fixture(t);
  await runArcadiaMonitor(f.env);
  const baseline = await readFile(f.env.ZHIXUE_STATE_FILE, "utf8");
  f.setScore(96);
  f.setBarkStatus(503);
  assert.equal(await runArcadiaMonitor(f.env), 1);
  assert.equal(await readFile(f.env.ZHIXUE_STATE_FILE, "utf8"), baseline);
  f.setBarkStatus(200);
  assert.equal(await runArcadiaMonitor(f.env), 0);
  assert.match(f.notices.at(-1).body, /90 → 96/);
  assert.equal(await runArcadiaMonitor(f.env), 0);
  assert.match(f.notices.at(-1).body, /成绩变化 0 项/);
});

test("missing BARK skips notices and still persists changes", async (t) => {
  const f = await fixture(t);
  delete f.env.BARK;
  assert.equal(await runArcadiaMonitor(f.env), 0);
  f.setScore(93);
  assert.equal(await runArcadiaMonitor(f.env), 0);
  assert.equal(f.notices.length, 0);
  assert.ok(f.logs.some((line) => /未设置 BARK/.test(line)));
  const saved = JSON.parse(await readFile(f.env.ZHIXUE_STATE_FILE, "utf8"));
  assert.equal(saved.grades["exam-1"].subjects.math.score, 93);
});

test("missing login configuration returns failure and sends a concise failure notice", async (t) => {
  const f = await fixture(t);
  delete f.env.ZHIXUE_COOKIE;
  assert.equal(await runArcadiaMonitor(f.env), 1);
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0].title, /运行失败/);
  assert.match(f.notices[0].body, /缺少 ZHIXUE_COOKIE/);
});

test("invalid JSON and invalid snapshot schemas are preserved on failure", async (t) => {
  const f = await fixture(t);
  for (const contents of ["broken json", "null", '{"version":1,"grades":[]}', '{"version":1,"grades":{"exam":null}}']) {
    await writeFile(f.env.ZHIXUE_STATE_FILE, contents);
    assert.equal(await runArcadiaMonitor(f.env), 1);
    assert.equal(await readFile(f.env.ZHIXUE_STATE_FILE, "utf8"), contents);
    assert.match(f.notices.at(-1).body, /快照/);
  }
});

test("the file lock rejects overlapping runs and releases after failures", async (t) => {
  const f = await fixture(t);
  await withFileStateLock(f.env.ZHIXUE_STATE_FILE, async () => {
    assert.equal(await runArcadiaMonitor(f.env), 1);
    assert.match(f.notices.at(-1).body, /快照已锁定/);
  });
  await assert.rejects(withFileStateLock(f.env.ZHIXUE_STATE_FILE, async () => { throw new Error("test failure"); }), /test failure/);
  assert.equal(await runArcadiaMonitor(f.env), 0);
});

test("Bark checks application status and sanitizes transport failures", async (t) => {
  const f = await fixture(t);
  globalThis.fetch = async () => Response.json({ code: 400, message: "private upstream details" });
  await assert.rejects(sendBarkNotification(f.env.BARK, "title", "body"), /code=400/);
  globalThis.fetch = async () => { throw new TypeError("private transport details", { cause: { code: "ECONNRESET" } }); };
  await assert.rejects(sendBarkNotification(f.env.BARK, "title", "body"), { message: "Bark 连接失败 (ECONNRESET)" });
  globalThis.fetch = async () => new Response("private invalid response");
  await assert.rejects(sendBarkNotification(f.env.BARK, "title", "body"), { message: "Bark 响应不是有效 JSON" });
});

test("the actual CLI exits with status 1 for missing configuration without networking", () => {
  const scriptPath = fileURLToPath(new URL("../scripts/arcadia-monitor.js", import.meta.url));
  assert.throws(() => execFileSync(process.execPath, [scriptPath], { env: {}, encoding: "utf8", stdio: "pipe" }), (error) => {
    assert.equal(error.status, 1);
    assert.match(error.stderr, /缺少 ZHIXUE_COOKIE/);
    assert.match(error.stderr, /未设置 BARK/);
    return true;
  });
});

test("Arcadia passes rotated cookies to token and report requests, then reuses them next run", async (t) => {
  const f = await fixture(t);
  const upstream = globalThis.fetch;
  let shouldRotate = true;
  const requests = [];
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.hostname !== "www.zhixue.com") return upstream(input, options);
    requests.push({ path: url.pathname, cookie: new Headers(options.headers).get("Cookie") });
    const result = await upstream(input, options);
    if (shouldRotate && url.pathname === "/container/getCurrentUser") {
      result.headers.append("Set-Cookie", "JSESSIONID=rotated-secret; Path=/; HttpOnly; Secure");
      shouldRotate = false;
    }
    return result;
  };
  assert.equal(await runArcadiaMonitor(f.env), 0);
  assert.equal(await runArcadiaMonitor(f.env), 0);
  assert.match(requests[0].cookie, /test-session/);
  for (const request of requests.slice(1)) assert.equal(request.cookie, "JSESSIONID=rotated-secret");
  assert.equal(f.logs.some((line) => /rotated-secret/.test(line)), false);
  assert.ok(f.logs.some((line) => /Cookie 会话更新已持久化/.test(line)));
});

test("Cookie rotation survives a later failed report and Bark notification", async (t) => {
  const f = await fixture(t);
  const upstream = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.pathname === "/container/getCurrentUser") {
      const result = await upstream(input, options);
      result.headers.append("Set-Cookie", "JSESSIONID=survives-failure; Path=/");
      return result;
    }
    if (url.pathname === "/zhixuebao/report/exam/getReportMain") return new Response("unavailable", { status: 503 });
    return upstream(input, options);
  };
  f.setBarkStatus(503);
  assert.equal(await runArcadiaMonitor(f.env), 1);
  const saved = JSON.parse(await readFile(`${f.env.ZHIXUE_STATE_FILE}.cookies.json`, "utf8"));
  assert.equal(saved.cookies.find((cookie) => cookie.name === "JSESSIONID").value, "survives-failure");
  globalThis.fetch = async (input, options) => {
    if (new URL(input).hostname === "www.zhixue.com") {
      assert.equal(new Headers(options.headers).get("Cookie"), "JSESSIONID=survives-failure");
    }
    return upstream(input, options);
  };
  f.setBarkStatus(200);
  assert.equal(await runArcadiaMonitor(f.env), 0);
});
