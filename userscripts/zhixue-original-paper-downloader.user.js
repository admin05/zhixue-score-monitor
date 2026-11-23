// ==UserScript==
// @name         智学网考生批改原卷打印
// @namespace    https://github.com/admin05/zhixue-score-monitor
// @version      1.1.0
// @description  在智学网成绩报告页批量打印所选考试各科带批改的原卷
// @match        https://www.zhixue.com/activitystudy/web-report/*
// @updateURL    https://raw.githubusercontent.com/admin05/zhixue-score-monitor/main/userscripts/zhixue-original-paper-downloader.user.js
// @downloadURL  https://raw.githubusercontent.com/admin05/zhixue-score-monitor/main/userscripts/zhixue-original-paper-downloader.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const BASE_URL = "https://www.zhixue.com";
  const PAGE_SIZE = 10;

  function md5Hex(value) {
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
    const constants = Array.from(
      { length: 64 },
      (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0,
    );
    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;

    for (let offset = 0; offset < bytes.length; offset += 64) {
      const words = new Uint32Array(16);
      for (let index = 0; index < 16; index += 1) {
        words[index] = view.getUint32(offset + index * 4, true);
      }
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

  function makeUrl(path, params = {}) {
    const url = new URL(path, BASE_URL);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
    return url;
  }

  async function getJson(path, params = {}, headers = {}) {
    const response = await fetch(makeUrl(path, params), {
      credentials: "include",
      headers,
    });
    if (!response.ok) throw new Error(`${path} 请求失败：HTTP ${response.status}`);
    const body = await response.json();
    if (body?.success === false) {
      throw new Error(`${path} 返回失败，错误码：${body.errorCode ?? body.code ?? "未知"}`);
    }
    return body;
  }

  function resultOf(body, label) {
    if (!body || !Object.hasOwn(body, "result")) {
      throw new Error(`${label}响应格式异常`);
    }
    return body.result;
  }

  async function getAuthHeaders() {
    const authGuid = crypto.randomUUID();
    const authTimestamp = String(Date.now());
    const baseHeaders = {
      authbizcode: "0001",
      authguid: authGuid,
      authtimestamp: authTimestamp,
      authtoken: md5Hex(`${authGuid}${authTimestamp}iflytek!@#123student`),
    };
    const tokenBody = await getJson("/container/app/token/getToken", {}, baseHeaders);
    const xToken = resultOf(tokenBody, "登录令牌");
    if (typeof xToken !== "string" || !xToken) throw new Error("登录令牌为空");
    return { ...baseHeaders, XToken: xToken };
  }

  async function getExams(authHeaders) {
    const years = resultOf(
      await getJson("/zhixuebao/base/common/academicYear", {}, authHeaders),
      "学年列表",
    );
    if (!Array.isArray(years) || !years.length) throw new Error("没有找到学年");

    const exams = [];
    for (let pageIndex = 1; pageIndex <= 20; pageIndex += 1) {
      const result = resultOf(
        await getJson("/zhixuebao/report/exam/getUserExamList", {
          pageIndex,
          pageSize: PAGE_SIZE,
          startSchoolYear: years[0].beginTime,
          endSchoolYear: years[0].endTime,
        }, authHeaders),
        "考试列表",
      );
      const page = Array.isArray(result?.examList) ? result.examList : [];
      exams.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    return { years, exams };
  }

  function waitForPageRender() {
    return new Promise((resolve) => {
      let stableTimer;
      let minimumTimer;
      let finished = false;
      const observer = new MutationObserver(check);
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(stableTimer);
        clearTimeout(minimumTimer);
        observer.disconnect();
        resolve();
      };
      const check = () => {
        clearTimeout(stableTimer);
        stableTimer = setTimeout(() => {
          if (Date.now() - startedAt >= 5000) finish();
          else check();
        }, 1000);
      };
      const startedAt = Date.now();
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      minimumTimer = setTimeout(finish, 20_000);
      check();
    });
  }

  async function printPaper(exam, paper, year) {
    const route = [
      "",
      "zxb-report",
      "original-roll-detail",
      exam.examId,
      paper.paperId,
      year.beginTime,
      year.endTime,
    ].map(encodeURIComponent).join("/");

    let sawBeforePrint = false;
    let finishPrint;
    const printFinished = new Promise((resolve) => { finishPrint = resolve; });
    const onBeforePrint = () => { sawBeforePrint = true; };
    const onAfterPrint = () => finishPrint();
    window.addEventListener("beforeprint", onBeforePrint);
    window.addEventListener("afterprint", onAfterPrint, { once: true });

    try {
      window.location.hash = route;
      await waitForPageRender();
      if (!sawBeforePrint) window.print();
      let timeoutId;
      await Promise.race([
        printFinished,
        new Promise((resolve) => { timeoutId = setTimeout(resolve, 60_000); }),
      ]);
      clearTimeout(timeoutId);
    } finally {
      window.removeEventListener("beforeprint", onBeforePrint);
      window.removeEventListener("afterprint", onAfterPrint);
    }
  }

  async function printExam(exam, year, authHeaders) {
    const report = resultOf(
      await getJson("/zhixuebao/report/exam/getReportMain", { examId: exam.examId }, authHeaders),
      "考试报告",
    );
    const papers = Array.isArray(report?.paperList) ? report.paperList : [];
    if (!papers.length) throw new Error("报告中没有可下载的科目");

    let printCount = 0;
    const failures = [];
    for (const paper of papers) {
      if (!paper?.paperId) continue;
      try {
        await printPaper(exam, paper, year);
        printCount += 1;
      } catch (error) {
        failures.push(`${paper.subjectName}：${error instanceof Error ? error.message : "打印失败"}`);
      }
    }
    return { printCount, failures };
  }

  async function startDownload(button) {
    button.disabled = true;
    button.textContent = "读取考试列表…";
    try {
      const authHeaders = await getAuthHeaders();
      const { years, exams } = await getExams(authHeaders);
      if (!exams.length) throw new Error("本学年没有找到考试");

      const menu = exams.map((exam, index) => `${index + 1}. ${exam.examName}`).join("\n");
      const answer = prompt(`输入要下载的考试序号：\n\n${menu}`, "1");
      if (answer === null) return;
      const exam = exams[Number(answer) - 1];
      if (!exam?.examId) throw new Error("序号无效");

      button.textContent = "准备打印带批改原卷…";
      const { printCount, failures } = await printExam(exam, years[0], authHeaders);
      button.textContent = `已打印 ${printCount} 个科目`;
      const summary = `考试：${exam.examName}\n已打开 ${printCount} 个科目的打印窗口`;
      if (failures.length) {
        console.warn("原卷打印未完成的项目：", failures);
        alert(`${summary}\n\n未完成 ${failures.length} 项，详情见 Console。`);
      } else {
        alert(`${summary}\n\n请在每个打印窗口中选择“另存为 PDF”并保存。`);
      }
    } catch (error) {
      console.error("智学网原卷打印失败：", error);
      button.textContent = "打印失败，点击重试";
      alert(`原卷打印失败：${error.message}`);
    } finally {
      button.disabled = false;
    }
  }

  function installButton() {
    if (!document.body || document.getElementById("zxw-original-paper-downloader")) return;
    const button = document.createElement("button");
    button.id = "zxw-original-paper-downloader";
    button.type = "button";
    button.textContent = "打印带批改原卷";
    button.title = "选择一场考试，逐科打开包含红色批改的原卷打印窗口";
    Object.assign(button.style, {
      position: "fixed",
      right: "20px",
      bottom: "24px",
      zIndex: "2147483647",
      padding: "10px 16px",
      border: "0",
      borderRadius: "6px",
      background: "#1677ff",
      color: "#fff",
      fontSize: "14px",
      fontWeight: "600",
      boxShadow: "0 2px 8px rgba(0,0,0,.2)",
      cursor: "pointer",
    });
    button.addEventListener("click", () => startDownload(button));
    document.body.appendChild(button);
  }

  installButton();
  new MutationObserver(installButton).observe(document.documentElement, { childList: true, subtree: true });
})();
