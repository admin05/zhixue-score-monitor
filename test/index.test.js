import test from "node:test";
import assert from "node:assert/strict";
import monitor, { buildSessionCookie, findScoreChanges, md5Hex, parseCookieHeader, probeZhixue, runMonitor } from "../src/index.js";

test("parses cookie values containing equals signs", () => {
  assert.deepEqual(parseCookieHeader("a=1; loginUserName=student%3D1; session=abc=="), {
    a: "1",
    loginUserName: "student%3D1",
    session: "abc==",
  });
});

test("uses current browser cookies as-is when loginUserName is absent", () => {
  assert.equal(buildSessionCookie("JSESSIONID=session; tlsysSessionId=system; ui=desktop"),
    "JSESSIONID=session; tlsysSessionId=system; ui=desktop");
});

test("adds the legacy uname cookie only when loginUserName exists", () => {
  assert.equal(buildSessionCookie("loginUserName=student; JSESSIONID=session"),
    "loginUserName=student; JSESSIONID=session; uname=c3R1ZGVudA==");
  assert.equal(buildSessionCookie("loginUserName=student; uname=already-set"),
    "loginUserName=student; uname=already-set");
});

test("computes MD5 hashes needed by the Zhixue token endpoint", () => {
  assert.equal(md5Hex(""), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(md5Hex("abc"), "900150983cd24fb0d6963f7d28e17f72");
});

test("probes account and exam-list access without requesting score reports", async () => {
  const originalFetch = globalThis.fetch;
  const requestedPaths = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    requestedPaths.push(url.pathname);
    if (url.pathname === "/container/getCurrentUser") return Response.json({ result: { role: "student" } });
    if (url.pathname === "/container/app/token/getToken") return Response.json({ result: "test-token" });
    if (url.pathname === "/zhixuebao/base/common/academicYear") {
      return Response.json({ result: [{ beginTime: "2026-09-01", endTime: "2027-08-31" }] });
    }
    if (url.pathname === "/zhixuebao/report/exam/getUserExamList") {
      return Response.json({ result: { examList: [{ examId: "exam-1" }, { examId: "exam-2" }] } });
    }
    throw new Error(`Unexpected request to ${url.pathname}`);
  };

  try {
    assert.deepEqual(await probeZhixue("JSESSIONID=test"), { academicYearCount: 1, examCount: 2 });
    assert.deepEqual(requestedPaths, [
      "/container/getCurrentUser",
      "/container/app/token/getToken",
      "/zhixuebao/base/common/academicYear",
      "/zhixuebao/report/exam/getUserExamList",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("includes safe upstream diagnostics for failed Zhixue requests", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("upstream error", {
    status: 525,
    headers: { server: "test-proxy", "cf-ray": "test-ray" },
  });

  try {
    await assert.rejects(
      runMonitor({
        ZHIXUE_COOKIE: "sensitive-cookie=value",
        STATE: { async get() { return null; } },
      }),
      (error) => {
        assert.match(error.message, /智学网请求失败 \(525/);
        assert.match(error.message, /URL=https:\/\/www\.zhixue\.com\/container\/getCurrentUser/);
        assert.match(error.message, /Server=test-proxy/);
        assert.match(error.message, /CF-Ray=test-ray/);
        assert.doesNotMatch(error.message, /sensitive-cookie/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports safe network error codes when Zhixue cannot be reached", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed", { cause: { code: "ECONNRESET", syscall: "connect" } });
  };

  try {
    await assert.rejects(
      probeZhixue("private-cookie=value"),
      (error) => {
        assert.equal(error.message, "智学网连接失败 (host=www.zhixue.com; code=ECONNRESET; syscall=connect)");
        assert.doesNotMatch(error.message, /private-cookie/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("identifies rejected endpoints without exposing response messages or credentials", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(input);
      if (url.pathname === "/container/getCurrentUser") return Response.json({ result: { role: "student" } });
      return Response.json({ success: false, code: 401, message: "sensitive-token=private-token" });
    };
    await assert.rejects(probeZhixue("private-cookie=value"), (error) => {
      assert.match(error.message, /接口=\/container\/app\/token\/getToken/);
      assert.match(error.message, /HTTP=200; code=401; success=false/);
      assert.match(error.message, /登录凭据被拒绝/);
      assert.doesNotMatch(error.message, /private-cookie|private-token|sensitive-token/);
      return true;
    });
    globalThis.fetch = async () => Response.json({ success: false, code: "private-error-token", message: "private-message" });
    await assert.rejects(probeZhixue("private-cookie=value"), (error) => {
      assert.match(error.message, /接口=\/container\/getCurrentUser/);
      assert.match(error.message, /code=未提供数字错误码/);
      assert.match(error.message, /不能仅凭 success=false 判定 Cookie 过期/);
      assert.doesNotMatch(error.message, /private-error-token|private-message|private-cookie/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("protects the manual trigger endpoint and accepts authorized POST requests", async () => {
  const request = new Request("https://monitor.example/__run", { method: "POST" });
  const unauthorized = await monitor.fetch(request, { MANUAL_TRIGGER_KEY: "expected" }, { waitUntil() {} });
  assert.equal(unauthorized.status, 401);

  const wrongMethod = await monitor.fetch(
    new Request("https://monitor.example/__run"),
    { MANUAL_TRIGGER_KEY: "expected" },
    { waitUntil() {} },
  );
  assert.equal(wrongMethod.status, 405);

  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  let monitorTask;
  globalThis.fetch = async () => new Response("upstream error", {
    status: 525,
    headers: { server: "test-proxy" },
  });
  console.error = () => {};

  try {
    const accepted = await monitor.fetch(
      new Request("https://monitor.example/__run", {
        method: "POST",
        headers: { Authorization: "Bearer expected" },
      }),
      {
        MANUAL_TRIGGER_KEY: "expected",
        ZHIXUE_COOKIE: "test-cookie",
        STATE: { async get() { return null; } },
      },
      { waitUntil(task) { monitorTask = task; } },
    );
    assert.equal(accepted.status, 202);
    assert.equal(await accepted.text(), "Monitor run started");
    await assert.rejects(monitorTask, /智学网请求失败 \(525/);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

test("reports newly published and corrected subject scores without treating the first baseline as changes", () => {
  const previous = {
    exam1: { name: "月考", subjects: { math: { name: "数学", score: 90 } } },
  };
  const current = [
    { id: "exam1", name: "月考", subjects: { math: { name: "数学", score: 95 }, chinese: { name: "语文", score: 88 } } },
    { id: "exam2", name: "期中", subjects: { math: { name: "数学", score: 91 } } },
  ];
  assert.deepEqual(findScoreChanges(previous, current), [
    { exam: "月考", subject: "数学", oldScore: 90, score: 95, kind: "changed" },
    { exam: "月考", subject: "语文", score: 88, kind: "new" },
    { exam: "期中", subject: "数学", score: 91, kind: "new" },
  ]);
});

test("stores a baseline first, then notifies only after a score changes", async () => {
  let state = null;
  let mathScore = 90;
  const barkCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.hostname === "www.zhixue.com") {
      if (url.pathname === "/container/getCurrentUser") return Response.json({ result: { role: "student" } });
      if (url.pathname === "/container/app/token/getToken") return Response.json({ result: "test-token" });
      if (url.pathname === "/zhixuebao/base/common/academicYear") {
        return Response.json({ result: [{ beginTime: "2026-09-01", endTime: "2027-08-31" }] });
      }
      if (url.pathname === "/zhixuebao/report/exam/getUserExamList") {
        return Response.json({ result: { examList: [{ examId: "exam-1", examName: "月考" }] } });
      }
      if (url.pathname === "/zhixuebao/report/exam/getReportMain") {
        return Response.json({ result: { paperList: [{ paperId: "math", subjectName: "数学", userScore: mathScore }] } });
      }
    }
    if (url.hostname === "api.day.app") {
      barkCalls.push(url.pathname);
      return new Response("ok", { status: 200 });
    }
    throw new Error(`Unexpected request to ${url.hostname}${url.pathname}`);
  };

  const env = {
    ZHIXUE_COOKIE: "JSESSIONID=test-session; tlsysSessionId=test-system-session",
    BARK_KEY: "test-bark-key",
    STATE: {
      async get(_key, type) {
        return state === null ? null : type === "json" ? structuredClone(state) : JSON.stringify(state);
      },
      async put(_key, value) {
        state = JSON.parse(value);
      },
    },
  };

  try {
    await runMonitor(env);
    assert.equal(barkCalls.length, 0);
    assert.equal(state.grades["exam-1"].subjects.math.score, 90);
    mathScore = 91;
    await runMonitor(env);
    assert.equal(barkCalls.length, 1);
    assert.equal(state.grades["exam-1"].subjects.math.score, 91);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
