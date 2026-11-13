import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseCookieHeader } from "./index.js";

const ORIGIN = "https://www.zhixue.com";
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function pathMatches(requestPath, cookiePath) {
  return requestPath === cookiePath || (requestPath.startsWith(cookiePath) &&
    (cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/"));
}

function validCookie(cookie) {
  return cookie && COOKIE_NAME.test(cookie.name) && typeof cookie.value === "string" &&
    !/[;\r\n\x00-\x1f\x7f]/.test(cookie.value) &&
    ["www.zhixue.com", "zhixue.com"].includes(cookie.domain) &&
    typeof cookie.path === "string" && cookie.path.startsWith("/") &&
    typeof cookie.hostOnly === "boolean" && typeof cookie.secure === "boolean" &&
    typeof cookie.imported === "boolean" && (cookie.derived === undefined || typeof cookie.derived === "boolean") &&
    (cookie.expires === null || (Number.isFinite(cookie.expires) && cookie.expires >= 0));
}

// 浏览器请求头不含 Domain/Path/Expires，导入时视作本站根路径 Cookie。
function importCookies(value) {
  const parsed = parseCookieHeader(value.trim());
  const cookies = Object.entries(parsed).map(([name, cookieValue]) => ({
    name, value: cookieValue, domain: "www.zhixue.com", hostOnly: true,
    path: "/", secure: true, expires: null, imported: true,
  })).filter(validCookie);
  if (parsed.loginUserName && !Object.keys(parsed).some((name) => name.toLowerCase() === "uname")) {
    cookies.push({
      name: "uname", value: btoa(parsed.loginUserName), domain: "www.zhixue.com",
      hostOnly: true, path: "/", secure: true, expires: null, imported: true, derived: true,
    });
  }
  return cookies;
}

function parseSetCookie(line, url, now) {
  const [pair, ...attributes] = line.split(";");
  const separator = pair.indexOf("=");
  if (separator < 1) return null;
  const attrs = new Map(attributes.map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [part.trim().toLowerCase(), ""] :
      [part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim()];
  }));
  const domain = attrs.has("domain") ? attrs.get("domain").toLowerCase().replace(/^\./, "") : url.hostname;
  if (![url.hostname, "zhixue.com"].includes(domain)) return null;
  const defaultPath = url.pathname.slice(0, url.pathname.lastIndexOf("/")) || "/";
  const path = attrs.get("path")?.startsWith("/") ? attrs.get("path") : defaultPath;
  let expires = null;
  if (attrs.has("expires")) {
    const timestamp = Date.parse(attrs.get("expires"));
    if (Number.isFinite(timestamp)) expires = Math.max(0, timestamp);
  }
  if (/^-?\d+$/.test(attrs.get("max-age") ?? "")) {
    const seconds = Number(attrs.get("max-age"));
    if (Number.isFinite(seconds)) expires = seconds <= 0 ? 0 : Math.min(now + seconds * 1000, Number.MAX_SAFE_INTEGER);
  }
  const cookie = {
    name: pair.slice(0, separator).trim(), value: pair.slice(separator + 1).trim(),
    domain, hostOnly: !attrs.has("domain"), path, secure: attrs.has("secure"), expires, imported: false,
  };
  return validCookie(cookie) ? cookie : null;
}

export async function createCookieSession(seed, filePath) {
  const sourceHash = createHash("sha256").update(seed.trim()).digest("hex");
  let cookies;
  try {
    const saved = JSON.parse(await readFile(filePath, "utf8"));
    // 手动更换环境变量时，旧会话不再覆盖新登录。
    if (saved?.sourceHash === sourceHash) {
      if (saved.version !== 1 || !Array.isArray(saved.cookies) || !saved.cookies.every(validCookie)) {
        throw new Error("invalid cookie file");
      }
      cookies = saved.cookies;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("读取 Cookie 会话失败，请检查文件权限或移走会话文件后重试；成绩快照无需删除");
  }
  if (!cookies) {
    cookies = importCookies(seed);
    if (!cookies.length) throw new Error("ZHIXUE_COOKIE 格式无效，请填写完整 Cookie 请求头的值");
  }
  let updateCount = 0;

  async function save() {
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(temporaryPath, JSON.stringify({ version: 1, sourceHash, cookies }), { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, filePath);
    } catch {
      throw new Error("保存 Cookie 会话失败，请检查持久化目录是否可写");
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  // 先保存手动导入结果；后续失败也不恢复已经失效的旧 Cookie。
  await save();
  return {
    get updateCount() { return updateCount; },
    async fetch(input, options = {}) {
      let url = new URL(input);
      for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
        if (url.origin !== ORIGIN) throw new Error("智学网请求跳转至其他站点，已停止发送登录信息");
        const now = Date.now();
        cookies = cookies.filter((cookie) => cookie.expires === null || cookie.expires > now);
        const headers = new Headers(options.headers);
        const applicable = cookies.filter((cookie) => pathMatches(url.pathname, cookie.path));
        applicable.sort((a, b) => b.path.length - a.path.length);
        headers.set("Cookie", applicable.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "));
        // 手动跟随跳转，确保中间响应的 Set-Cookie 也被保存。
        const response = await fetch(url, { ...options, headers, redirect: "manual" });
        const lines = response.headers.getSetCookie();
        let updates = 0;
        for (const line of lines) {
          const cookie = parseSetCookie(line, url, Date.now());
          if (!cookie) continue;
          updates += 1;
          if (cookie.name.toLowerCase() === "loginusername") {
            const derivedUname = cookies.find((old) => old.derived);
            if (derivedUname) derivedUname.value = btoa(cookie.value);
          }
          cookies = cookies.filter((old) => !(old.name === cookie.name &&
            (old.imported || (old.domain === cookie.domain && old.path === cookie.path))));
          if (cookie.expires === null || cookie.expires > Date.now()) cookies.push(cookie);
        }
        // 必须在解析 JSON/状态码之前保存：即使后续请求失败，轮换也不能丢。
        await save();
        updateCount += updates;
        if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.has("location")) return response;
        await response.body?.cancel();
        if (redirectCount === 5) throw new Error("智学网请求重定向次数过多");
        url = new URL(response.headers.get("location"), url);
      }
    },
  };
}
