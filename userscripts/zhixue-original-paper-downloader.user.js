// ==UserScript==
// @name         智学网考生原卷批量下载
// @namespace    https://github.com/admin05/zhixue-score-monitor
// @version      1.0.0
// @description  在智学网成绩报告页批量下载所选考试各科原卷图片
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
    return exams;
  }

  function safeFilename(value) {
    return String(value || "")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, "_");
  }

  function imageExtension(blob, imageUrl) {
    if (blob.type.includes("png")) return "png";
    if (blob.type.includes("webp")) return "webp";
    const match = new URL(imageUrl).pathname.match(/\.(jpe?g|png|webp)$/i);
    return match ? match[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
  }

  async function downloadExam(exam, authHeaders) {
    const report = resultOf(
      await getJson("/zhixuebao/report/exam/getReportMain", { examId: exam.examId }, authHeaders),
      "考试报告",
    );
    const papers = Array.isArray(report?.paperList) ? report.paperList : [];
    if (!papers.length) throw new Error("报告中没有可下载的科目");

    let downloadCount = 0;
    const failures = [];
    for (const paper of papers) {
      if (!paper?.paperId) continue;
      try {
        const body = await getJson("/zhixuebao/report/checksheet/", {
          examId: exam.examId,
          paperId: paper.paperId,
        }, authHeaders);
        const result = resultOf(body, `原卷 ${paper.subjectName}`);
        let images = result?.sheetImages ?? [];
        if (typeof images === "string") {
          try {
            images = JSON.parse(images);
          } catch {
            images = [];
          }
        }
        if (!Array.isArray(images) || !images.length) {
          failures.push(`${paper.subjectName}：没有原卷图片`);
          continue;
        }

        for (let index = 0; index < images.length; index += 1) {
          const imageUrl = new URL(images[index], BASE_URL);
          try {
            const response = await fetch(imageUrl, { credentials: "include" });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            const link = document.createElement("a");
            link.href = URL.createObjectURL(blob);
            link.download = `${safeFilename(exam.examName)}_${safeFilename(paper.subjectName)}_${String(index + 1).padStart(2, "0")}.${imageExtension(blob, imageUrl)}`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
            downloadCount += 1;
            await new Promise((resolve) => setTimeout(resolve, 400));
          } catch (error) {
            failures.push(`${paper.subjectName} 第 ${index + 1} 页：${error.message}`);
          }
        }
      } catch (error) {
        failures.push(`${paper.subjectName}：${error.message}`);
      }
    }
    return { downloadCount, failures };
  }

  async function startDownload(button) {
    button.disabled = true;
    button.textContent = "读取考试列表…";
    try {
      const authHeaders = await getAuthHeaders();
      const exams = await getExams(authHeaders);
      if (!exams.length) throw new Error("本学年没有找到考试");

      const menu = exams.map((exam, index) => `${index + 1}. ${exam.examName}`).join("\n");
      const answer = prompt(`输入要下载的考试序号：\n\n${menu}`, "1");
      if (answer === null) return;
      const exam = exams[Number(answer) - 1];
      if (!exam?.examId) throw new Error("序号无效");

      button.textContent = "下载原卷中…";
      const { downloadCount, failures } = await downloadExam(exam, authHeaders);
      button.textContent = `已触发 ${downloadCount} 页下载`;
      const summary = `考试：${exam.examName}\n已触发下载：${downloadCount} 张图片`;
      if (failures.length) {
        console.warn("原卷下载未完成的项目：", failures);
        alert(`${summary}\n\n未完成 ${failures.length} 项，详情见 Console。`);
      } else {
        alert(`${summary}\n\n请检查 Chrome 下载列表。`);
      }
    } catch (error) {
      console.error("智学网原卷下载失败：", error);
      button.textContent = "下载失败，点击重试";
      alert(`原卷下载失败：${error.message}`);
    } finally {
      button.disabled = false;
    }
  }

  function installButton() {
    if (!document.body || document.getElementById("zxw-original-paper-downloader")) return;
    const button = document.createElement("button");
    button.id = "zxw-original-paper-downloader";
    button.type = "button";
    button.textContent = "下载考生原卷";
    button.title = "选择一场考试，批量下载该场考试各科原卷图片";
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
