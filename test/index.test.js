import test from "node:test";
import assert from "node:assert/strict";
import { buildSessionCookie, findScoreChanges, md5Hex, parseCookieHeader, runMonitor } from "../src/index.js";

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
