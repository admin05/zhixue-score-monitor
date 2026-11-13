// 智学网成绩监控 (Arcadia)
// Cron: 0 */15 * * * *
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatScoreChanges, runMonitor } from "../src/index.js";
import { sendBarkNotification } from "../src/bark.js";
import { createFileState, withFileStateLock } from "../src/file-state.js";

const SCRIPT_NAME = "智学网成绩监控 (Arcadia)";

export async function runArcadiaMonitor(env = process.env) {
  const statePath = env.ZHIXUE_STATE_FILE?.trim() || fileURLToPath(new URL("../data/score-snapshot.json", import.meta.url));
  try {
    if (!env.ZHIXUE_COOKIE?.trim()) throw new Error("缺少 ZHIXUE_COOKIE 环境变量，请在 Arcadia 环境配置中添加登录 Cookie");
    await withFileStateLock(statePath, async () => {
      const result = await runMonitor({
        ZHIXUE_COOKIE: env.ZHIXUE_COOKIE,
        STATE: createFileState(statePath),
      }, {
        // 推送失败时不推进快照，下次运行仍会重试这些变化。
        notifyChanges: (changes, { examCount }) => sendBarkNotification(
          env.BARK,
          `${SCRIPT_NAME}运行成功`,
          `扫描 ${examCount} 场考试；成绩变化 ${changes.length} 项\n${formatScoreChanges(changes)}`,
        ),
      });
      const stage = result.baselineCreated ? "已建立首次成绩基线" : "扫描完成";
      const summary = `${stage}；考试 ${result.examCount} 场；成绩变化 ${result.changeCount} 项`;
      console.log(`${SCRIPT_NAME}：成功；${summary}`);
      if (!result.changeCount) await sendBarkNotification(env.BARK, `${SCRIPT_NAME}运行成功`, summary);
    });
    return 0;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "未知错误";
    console.error(`${SCRIPT_NAME}：失败；${detail}`);
    try {
      await sendBarkNotification(env.BARK, `${SCRIPT_NAME}运行失败`, detail.slice(0, 1500));
    } catch (notifyError) {
      console.error(`${SCRIPT_NAME}：失败通知未送达：${notifyError.message}`);
    }
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runArcadiaMonitor();
}
