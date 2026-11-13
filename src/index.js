const BASE_URL = "https://www.zhixue.com";
const STATE_KEY = "score-snapshot-v1";
const PAGE_SIZE = 10;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";

export function parseCookieHeader(value) {
  const cookies = {};
  for (const part of value.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const cookieValue = part.slice(separator + 1).trim();
    if (name) cookies[name] = cookieValue;
  }
  return cookies;
}

export function buildSessionCookie(value) {
  const cookie = value.trim();
  const cookies = parseCookieHeader(cookie);
  const loginUserName = cookies.loginUserName;
  if (!loginUserName || Object.keys(cookies).some((name) => name.toLowerCase() === "uname")) return cookie;
  return `${cookie}; uname=${btoa(loginUserName)}`;
}

export function findScoreChanges(previous, current) {
  const changes = [];
  for (const exam of current) {
    const oldExam = previous[exam.id];
    for (const [subjectId, subject] of Object.entries(exam.subjects ?? {})) {
      const oldScore = oldExam?.subjects?.[subjectId]?.score;
      if (oldScore === undefined) {
        changes.push({ exam: exam.name, subject: subject.name, score: subject.score, kind: "new" });
        continue;
      }
      if (String(oldScore) !== String(subject.score)) {
        changes.push({ exam: exam.name, subject: subject.name, oldScore, score: subject.score, kind: "changed" });
      }
    }
  }
  return changes;
}

export function md5Hex(value) {
  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const bitLength = input.length * 8;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);

  const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const constants = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Uint32Array(16);
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let index = 0; index < 64; index += 1) {
      let f;
      let wordIndex;
      let shiftGroup;
      if (index < 16) {
        f = (b & c) | (~b & d);
        wordIndex = index;
        shiftGroup = 0;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        wordIndex = (5 * index + 1) % 16;
        shiftGroup = 1;
      } else if (index < 48) {
        f = b ^ c ^ d;
        wordIndex = (3 * index + 5) % 16;
        shiftGroup = 2;
      } else {
        f = c ^ (b | ~d);
        wordIndex = (7 * index) % 16;
        shiftGroup = 3;
      }
      const shift = shifts[shiftGroup * 4 + (index % 4)];
      const sum = (a + f + constants[index] + words[wordIndex]) >>> 0;
      const rotated = ((sum << shift) | (sum >>> (32 - shift))) >>> 0;
      [a, b, c, d] = [d, (b + rotated) >>> 0, b, c];
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  return [a0, b0, c0, d0]
    .flatMap((word) => [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff])
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function apiUrl(path, params = {}) {
  const url = new URL(path, BASE_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
}

async function getJson(url, headers = {}, fetchZhixue = globalThis.fetch) {
  let response;
  try {
    response = await fetchZhixue(url, {
      headers: { "User-Agent": USER_AGENT, Referer: "https://www.zhixue.com/", ...headers },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const code = error?.cause?.code ?? error?.code ?? error?.name ?? "unknown";
    const syscall = error?.cause?.syscall;
    const details = [`host=${url.hostname}`, `code=${code}`];
    if (syscall) details.push(`syscall=${syscall}`);
    throw new Error(`智学网连接失败 (${details.join("; ")})`);
  }
  if (!response.ok) {
    const server = response.headers.get("server") ?? "unknown";
    const cfRay = response.headers.get("cf-ray");
    const diagnostics = [`URL=${url.origin}${url.pathname}`, `Server=${server}`];
    if (cfRay) diagnostics.push(`CF-Ray=${cfRay}`);
    throw new Error(`智学网请求失败 (${response.status}; ${diagnostics.join("; ")})`);
  }
  const body = await response.json();
  const numericCode = (value) => /^-?\d{1,9}$/.test(String(value ?? "")) ? String(value) : null;
  const code = numericCode(body?.code);
  const errorCode = numericCode(body?.errorCode);
  const loginRejected = code === "401" || errorCode === "401" || errorCode === "3002";
  const upstreamError = body?.success !== true && errorCode !== null && !["0", "200"].includes(errorCode);
  if (body?.success === false || loginRejected || upstreamError) {
    // 只记录接口路径及数字错误码，不输出响应正文、令牌或查询参数。
    const details = [`接口=${url.pathname}`, `HTTP=${response.status}`, `code=${code ?? "未提供数字错误码"}`];
    if (errorCode !== null) details.push(`errorCode=${errorCode}`);
    if (body?.success === false) details.push("success=false");
    // 只允许这两个已核对过的固定提示，不输出任意 errorInfo 内容。
    if (["未登录或登录失效", "操作失败"].includes(body?.errorInfo)) details.push(`原因=${body.errorInfo}`);
    const suggestion = loginRejected
      ? "登录凭据被拒绝，请重新登录并更新 ZHIXUE_COOKIE 后重试"
      : "请结合接口及错误码排查登录状态或接口异常，不能仅凭 success=false 判定 Cookie 过期";
    throw new Error(`智学网拒绝了请求 (${details.join("; ")})；${suggestion}`);
  }
  return body;
}

function requireResult(body, label) {
  if (!body || !Object.hasOwn(body, "result")) throw new Error(`${label}响应格式异常`);
  return body.result;
}

async function getAuthHeaders(cookie, fetchZhixue) {
  const authGuid = crypto.randomUUID();
  const authTimestamp = String(Date.now());
  const authToken = md5Hex(`${authGuid}${authTimestamp}iflytek!@#123student`);
  const base = {
    authbizcode: "0001",
    authguid: authGuid,
    authtimestamp: authTimestamp,
    authtoken: authToken,
  };
  const body = await getJson(apiUrl("/container/app/token/getToken"), { Cookie: cookie, ...base }, fetchZhixue);
  const xToken = requireResult(body, "登录令牌");
  if (typeof xToken !== "string" || !xToken) throw new Error("登录令牌为空");
  return { ...base, XToken: xToken };
}

async function zhixueFetch(path, cookie, params, headers = {}, fetchZhixue) {
  return getJson(apiUrl(path, params), { Cookie: cookie, ...headers }, fetchZhixue);
}

function scoreSnapshot(examId, examName, report) {
  const result = requireResult(report, `考试 ${examId}`);
  const papers = Array.isArray(result?.paperList) ? result.paperList : [];
  const subjects = {};
  for (const paper of papers) {
    if (!paper || paper.userScore === undefined || paper.userScore === null || paper.userScore === "") continue;
    const id = String(paper.paperId ?? paper.subjectCode ?? paper.subjectName ?? "");
    if (!id) continue;
    subjects[id] = { name: String(paper.subjectName ?? "科目"), score: paper.userScore };
  }
  const totalScore = result?.totalScore;
  if (totalScore?.userScore !== undefined && totalScore?.userScore !== null && totalScore.userScore !== "") {
    subjects.totalScore = { name: String(totalScore.subjectName ?? "总分"), score: totalScore.userScore };
  }
  return { id: String(examId), name: String(examName), subjects };
}

async function loadExamContext(cookie, fetchZhixue) {
  const sessionCookie = buildSessionCookie(cookie);

  const user = requireResult(await zhixueFetch("/container/getCurrentUser", sessionCookie, {}, {}, fetchZhixue), "账号信息");
  if (!user || typeof user !== "object" || Array.isArray(user) || Object.keys(user).length === 0) {
    throw new Error("账号信息为空或格式异常 (接口=/container/getCurrentUser)，未通过登录检查，请重新登录并更新 ZHIXUE_COOKIE 后重试");
  }
  if (user?.role && user.role !== "student") throw new Error("当前 Cookie 对应的不是学生账号");

  const auth = await getAuthHeaders(sessionCookie, fetchZhixue);
  const academicYears = requireResult(
    await zhixueFetch("/zhixuebao/base/common/academicYear", sessionCookie, {}, auth, fetchZhixue),
    "学年列表",
  );
  if (!Array.isArray(academicYears) || academicYears.length === 0) {
    return { academicYearCount: 0, exams: [], sessionCookie, auth };
  }

  const year = academicYears[0];
  const examResult = requireResult(
    await zhixueFetch(
      "/zhixuebao/report/exam/getUserExamList",
      sessionCookie,
      { pageIndex: 1, pageSize: PAGE_SIZE, startSchoolYear: year.beginTime, endSchoolYear: year.endTime },
      auth,
      fetchZhixue,
    ),
    "考试列表",
  );
  const exams = Array.isArray(examResult?.examList) ? examResult.examList : [];
  return { academicYearCount: academicYears.length, exams, sessionCookie, auth };
}

export async function probeZhixue(cookie) {
  if (!cookie?.trim()) throw new Error("缺少 ZHIXUE_COOKIE 环境变量");
  const { academicYearCount, exams } = await loadExamContext(cookie);
  return { academicYearCount, examCount: exams.length };
}

async function loadCurrentScores(cookie, fetchZhixue) {
  const { exams, sessionCookie, auth } = await loadExamContext(cookie, fetchZhixue);

  const snapshots = [];
  for (const exam of exams) {
    if (!exam?.examId) continue;
    const report = await zhixueFetch(
      "/zhixuebao/report/exam/getReportMain",
      sessionCookie,
      { examId: exam.examId },
      auth,
      fetchZhixue,
    );
    snapshots.push(scoreSnapshot(exam.examId, exam.examName, report));
  }
  return snapshots;
}

export function formatScoreChanges(changes) {
  const lines = changes.slice(0, 18).map((change) => {
    const value = change.kind === "changed"
      ? `${change.oldScore} → ${change.score}`
      : `${change.score}`;
    return `${change.exam} / ${change.subject}: ${value}`;
  });
  if (changes.length > lines.length) lines.push(`另有 ${changes.length - lines.length} 项变化`);
  return lines.join("\n").slice(0, 2000);
}

async function sendBark(key, changes) {
  const url = new URL(`https://api.day.app/${encodeURIComponent(key)}/${encodeURIComponent("智学网成绩更新")}/${encodeURIComponent(formatScoreChanges(changes))}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Bark 推送失败 (${response.status})`);
}

export async function runMonitor(env, { notifyChanges, fetchZhixue } = {}) {
  if (!env.ZHIXUE_COOKIE) throw new Error("缺少 ZHIXUE_COOKIE Secret");
  if (!env.STATE) throw new Error("缺少 STATE KV 绑定");

  const previousState = await env.STATE.get(STATE_KEY, "json");
  const previous = previousState?.grades ?? {};
  const currentScores = await loadCurrentScores(env.ZHIXUE_COOKIE, fetchZhixue);
  const current = Object.fromEntries(currentScores.map((exam) => [exam.id, exam]));
  const changes = findScoreChanges(previous, currentScores);

  if (previousState === null) {
    await env.STATE.put(STATE_KEY, JSON.stringify({ version: 1, grades: current }));
    console.log(`基线已建立：扫描 ${currentScores.length} 场考试`);
    return { examCount: currentScores.length, changeCount: 0, baselineCreated: true };
  }

  if (changes.length) {
    if (notifyChanges) {
      await notifyChanges(changes, { examCount: currentScores.length });
    } else {
      if (!env.BARK_KEY) throw new Error("发现成绩变化，但缺少 BARK_KEY Secret");
      await sendBark(env.BARK_KEY, changes);
    }
  }
  const merged = { ...previous };
  for (const [id, exam] of Object.entries(current)) {
    merged[id] = {
      ...previous[id],
      ...exam,
      subjects: { ...previous[id]?.subjects, ...exam.subjects },
    };
  }
  await env.STATE.put(STATE_KEY, JSON.stringify({ version: 1, grades: merged }));
  console.log(`扫描完成：${currentScores.length} 场考试，${changes.length} 项成绩变化`);
  return { examCount: currentScores.length, changeCount: changes.length, baselineCreated: false };
}

function sameSecret(value, expected) {
  const left = new TextEncoder().encode(value);
  const right = new TextEncoder().encode(expected);
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function logMonitorFailure(error) {
  console.error(`智学网监控失败：${error instanceof Error ? error.message : "未知错误"}`);
  throw error;
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runMonitor(env).catch(logMonitorFailure));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/__run") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      if (!env.MANUAL_TRIGGER_KEY) return new Response("Manual trigger is not configured", { status: 503 });

      const authorization = request.headers.get("Authorization") ?? "";
      if (!sameSecret(authorization, `Bearer ${env.MANUAL_TRIGGER_KEY}`)) {
        return new Response("Unauthorized", { status: 401 });
      }

      ctx.waitUntil(runMonitor(env).catch(logMonitorFailure));
      return new Response("Monitor run started", { status: 202 });
    }
    return new Response("智学网成绩监控已运行", { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
