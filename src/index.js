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

async function getJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Referer: "https://www.zhixue.com/", ...headers },
    redirect: "follow",
  });
  if (!response.ok) {
    const server = response.headers.get("server") ?? "unknown";
    const cfRay = response.headers.get("cf-ray");
    const diagnostics = [`URL=${url.origin}${url.pathname}`, `Server=${server}`];
    if (cfRay) diagnostics.push(`CF-Ray=${cfRay}`);
    throw new Error(`智学网请求失败 (${response.status}; ${diagnostics.join("; ")})`);
  }
  const body = await response.json();
  if (body?.success === false || body?.code === "401" || body?.code === 401) {
    throw new Error("智学网拒绝了请求，请检查登录 Cookie 是否过期");
  }
  return body;
}

function requireResult(body, label) {
  if (!body || !Object.hasOwn(body, "result")) throw new Error(`${label}响应格式异常`);
  return body.result;
}

async function getAuthHeaders(cookie) {
  const authGuid = crypto.randomUUID();
  const authTimestamp = String(Date.now());
  const authToken = md5Hex(`${authGuid}${authTimestamp}iflytek!@#123student`);
  const base = {
    authbizcode: "0001",
    authguid: authGuid,
    authtimestamp: authTimestamp,
    authtoken: authToken,
  };
  const body = await getJson(apiUrl("/container/app/token/getToken"), { Cookie: cookie, ...base });
  const xToken = requireResult(body, "登录令牌");
  if (typeof xToken !== "string" || !xToken) throw new Error("登录令牌为空");
  return { ...base, XToken: xToken };
}

async function zhixueFetch(path, cookie, params, headers = {}) {
  return getJson(apiUrl(path, params), { Cookie: cookie, ...headers });
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

async function loadCurrentScores(cookie) {
  const sessionCookie = buildSessionCookie(cookie);

  const user = requireResult(await zhixueFetch("/container/getCurrentUser", sessionCookie), "账号信息");
  if (user?.role && user.role !== "student") throw new Error("当前 Cookie 对应的不是学生账号");

  const auth = await getAuthHeaders(sessionCookie);
  const academicYears = requireResult(
    await zhixueFetch("/zhixuebao/base/common/academicYear", sessionCookie, {}, auth),
    "学年列表",
  );
  if (!Array.isArray(academicYears) || academicYears.length === 0) return [];

  const year = academicYears[0];
  const examResult = requireResult(
    await zhixueFetch(
      "/zhixuebao/report/exam/getUserExamList",
      sessionCookie,
      { pageIndex: 1, pageSize: PAGE_SIZE, startSchoolYear: year.beginTime, endSchoolYear: year.endTime },
      auth,
    ),
    "考试列表",
  );
  const exams = Array.isArray(examResult?.examList) ? examResult.examList : [];

  const snapshots = [];
  for (const exam of exams) {
    if (!exam?.examId) continue;
    const report = await zhixueFetch(
      "/zhixuebao/report/exam/getReportMain",
      sessionCookie,
      { examId: exam.examId },
      auth,
    );
    snapshots.push(scoreSnapshot(exam.examId, exam.examName, report));
  }
  return snapshots;
}

async function sendBark(key, changes) {
  const lines = changes.slice(0, 18).map((change) => {
    const value = change.kind === "changed"
      ? `${change.oldScore} → ${change.score}`
      : `${change.score}`;
    return `${change.exam} / ${change.subject}: ${value}`;
  });
  if (changes.length > lines.length) lines.push(`另有 ${changes.length - lines.length} 项变化`);
  const url = new URL(`https://api.day.app/${encodeURIComponent(key)}/${encodeURIComponent("智学网成绩更新")}/${encodeURIComponent(lines.join("\n"))}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Bark 推送失败 (${response.status})`);
}

export async function runMonitor(env) {
  if (!env.ZHIXUE_COOKIE) throw new Error("缺少 ZHIXUE_COOKIE Secret");
  if (!env.STATE) throw new Error("缺少 STATE KV 绑定");

  const previousState = await env.STATE.get(STATE_KEY, "json");
  const previous = previousState?.grades ?? {};
  const currentScores = await loadCurrentScores(env.ZHIXUE_COOKIE);
  const current = Object.fromEntries(currentScores.map((exam) => [exam.id, exam]));
  const changes = findScoreChanges(previous, currentScores);

  if (previousState === null) {
    await env.STATE.put(STATE_KEY, JSON.stringify({ version: 1, grades: current }));
    console.log(`基线已建立：扫描 ${currentScores.length} 场考试`);
    return;
  }

  if (changes.length && !env.BARK_KEY) throw new Error("发现成绩变化，但缺少 BARK_KEY Secret");
  if (changes.length) await sendBark(env.BARK_KEY, changes);
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
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runMonitor(env).catch((error) => {
      console.error(`智学网监控失败：${error instanceof Error ? error.message : "未知错误"}`);
      throw error;
    }));
  },
  async fetch() {
    return new Response("智学网成绩监控已运行", { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
