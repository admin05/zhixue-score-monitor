import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCookieSession } from "../src/cookie-session.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "zhixue-cookie-"));
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  });
  return join(directory, "session.cookies.json");
}

function response(cookies = [], options = {}) {
  const headers = new Headers(options.headers);
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return Response.json({ result: {} }, { ...options, headers });
}

test("rotates multiple cookies, keeps equals signs, and reuses them across new sessions", async (t) => {
  const file = await fixture(t);
  const seed = "JSESSIONID=original; other=keep";
  const seen = [];
  globalThis.fetch = async (_url, options) => {
    seen.push(options.headers.get("Cookie"));
    return seen.length === 1 ? response([
      "JSESSIONID=rotated==; Domain=.zhixue.com; Path=/; HttpOnly; Secure",
      "newCookie=added; Expires=Wed, 09 Jun 2099 10:18:14 GMT; Path=/",
    ]) : response();
  };
  const session = await createCookieSession(seed, file);
  await session.fetch("https://www.zhixue.com/container/getCurrentUser");
  await session.fetch("https://www.zhixue.com/container/app/token/getToken");
  const nextRun = await createCookieSession(seed, file);
  await nextRun.fetch("https://www.zhixue.com/zhixuebao/base/common/academicYear");
  for (const header of seen.slice(1)) {
    assert.match(header, /JSESSIONID=rotated==/);
    assert.match(header, /other=keep/);
    assert.match(header, /newCookie=added/);
    assert.doesNotMatch(header, /original|Domain|Expires|HttpOnly/);
    assert.equal(header.match(/JSESSIONID=/g).length, 1);
  }
  assert.equal(session.updateCount, 2);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(file, "utf8"), /original/);
});

test("a changed environment Cookie replaces the cached login", async (t) => {
  const file = await fixture(t);
  const old = await createCookieSession("session=old; oldOnly=yes", file);
  globalThis.fetch = async () => response(["session=server-rotated; Path=/"]);
  await old.fetch("https://www.zhixue.com/");
  const replacement = await createCookieSession("session=manual-new; fresh=yes", file);
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers.get("Cookie"), "session=manual-new; fresh=yes");
    return response();
  };
  await replacement.fetch("https://www.zhixue.com/");
});

test("refreshes the legacy derived uname when the server rotates loginUserName", async (t) => {
  const file = await fixture(t);
  const session = await createCookieSession("loginUserName=student-one", file);
  globalThis.fetch = async (_url, options) => {
    if (options.headers.get("Cookie").includes("student-one")) {
      return response(["loginUserName=student-two; Path=/"]);
    }
    assert.deepEqual(options.headers.get("Cookie").split("; ").sort(), [
      "loginUserName=student-two", "uname=c3R1ZGVudC10d28=",
    ].sort());
    return response();
  };
  await session.fetch("https://www.zhixue.com/");
  await session.fetch("https://www.zhixue.com/");
});

test("honors path, default path, domain rejection, expiration and Max-Age precedence", async (t) => {
  const file = await fixture(t);
  const session = await createCookieSession("session=seed; gone=old; empty=old", file);
  let first = true;
  const seen = new Map();
  globalThis.fetch = async (url, options) => {
    if (first) {
      first = false;
      return response([
        "gone=deleted; Max-Age=0; Path=/",
        "empty=; Path=/",
        "past=old; Expires=Wed, 09 Jun 2021 10:18:14 GMT; Path=/",
        "valid=yes; Max-Age=3600; Expires=Wed, 09 Jun 2021 10:18:14 GMT; Path=/",
        "scoped=container; Path=/container",
        "default=local",
        "session=evil; Domain=evil.com; Path=/",
        "session=invalid; Domain=com; Path=/",
      ]);
    }
    seen.set(url.pathname, options.headers.get("Cookie"));
    return response();
  };
  await session.fetch("https://www.zhixue.com/container/getCurrentUser");
  for (const path of ["/container/token", "/containerOther", "/zhixuebao/report"]) {
    await session.fetch(`https://www.zhixue.com${path}`);
  }
  for (const header of seen.values()) {
    assert.match(header, /session=seed/);
    assert.match(header, /empty=/);
    assert.match(header, /valid=yes/);
    assert.doesNotMatch(header, /gone=|past=|evil|invalid/);
  }
  assert.match(seen.get("/container/token"), /scoped=container/);
  assert.match(seen.get("/container/token"), /default=local/);
  assert.doesNotMatch(seen.get("/containerOther"), /scoped=|default=/);
  assert.doesNotMatch(seen.get("/zhixuebao/report"), /scoped=|default=/);
});

test("same-name cookies in different paths coexist and the most specific goes first", async (t) => {
  const file = await fixture(t);
  const session = await createCookieSession("session=seed", file);
  globalThis.fetch = async () => response(["session=root; Path=/", "session=local; Path=/container"]);
  await session.fetch("https://www.zhixue.com/");
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers.get("Cookie"), "session=local; session=root");
    return response();
  };
  await session.fetch("https://www.zhixue.com/container/token");
});

test("retains redirect cookies before following the same-origin redirect", async (t) => {
  const file = await fixture(t);
  const session = await createCookieSession("session=seed", file);
  const seen = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(options.redirect, "manual");
    seen.push({ path: url.pathname, cookie: options.headers.get("Cookie") });
    return seen.length === 1 ? response(["session=redirected; Path=/"], { status: 302, headers: { location: "/next" } }) : response();
  };
  await session.fetch("https://www.zhixue.com/start");
  assert.deepEqual(seen, [{ path: "/start", cookie: "session=seed" }, { path: "/next", cookie: "session=redirected" }]);
});

test("blocks cross-origin redirects and redirect loops without losing updates", async (t) => {
  const file = await fixture(t);
  const session = await createCookieSession("session=seed", file);
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return response(["session=latest; Path=/"], { status: 302, headers: { location: "https://other.example/" } });
  };
  await assert.rejects(session.fetch("https://www.zhixue.com/"), /其他站点/);
  assert.equal(calls, 1);
  assert.match(await readFile(file, "utf8"), /latest/);
  globalThis.fetch = async () => response([], { status: 302, headers: { location: "/loop" } });
  await assert.rejects(session.fetch("https://www.zhixue.com/"), /重定向次数过多/);
});

test("server deletion of all cookies persists without resurrecting the static seed", async (t) => {
  const file = await fixture(t);
  const session = await createCookieSession("session=seed", file);
  globalThis.fetch = async () => response(["session=; Max-Age=0; Path=/"], { status: 401 });
  const rejected = await session.fetch("https://www.zhixue.com/");
  assert.equal(rejected.status, 401);
  const nextRun = await createCookieSession("session=seed", file);
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers.get("Cookie"), "");
    return response();
  };
  await nextRun.fetch("https://www.zhixue.com/");
});

test("expiry is rechecked on each request and survives a restart", async (t) => {
  const file = await fixture(t);
  const session = await createCookieSession("session=seed", file);
  globalThis.fetch = async () => response(["session=temporary; Max-Age=1; Path=/"]);
  await session.fetch("https://www.zhixue.com/");
  const originalNow = Date.now;
  const later = Date.now() + 2000;
  Date.now = () => later;
  t.after(() => { Date.now = originalNow; });
  const nextRun = await createCookieSession("session=seed", file);
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers.get("Cookie"), "");
    return response();
  };
  await nextRun.fetch("https://www.zhixue.com/");
});

test("corrupt cookie files fail safely and are not overwritten", async (t) => {
  const file = await fixture(t);
  await writeFile(file, "private-broken-cookie-value");
  await assert.rejects(createCookieSession("session=seed", file), (error) => {
    assert.match(error.message, /读取 Cookie 会话失败/);
    assert.doesNotMatch(error.message, /private-broken-cookie-value|session=seed/);
    return true;
  });
  assert.equal(await readFile(file, "utf8"), "private-broken-cookie-value");
});
