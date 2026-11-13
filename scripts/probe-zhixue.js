import { probeZhixue } from "../src/index.js";

try {
  const result = await probeZhixue(process.env.ZHIXUE_COOKIE);
  console.log(`智学网访问成功：学年 ${result.academicYearCount} 个，考试 ${result.examCount} 场`);
} catch (error) {
  console.error(`智学网访问失败：${error instanceof Error ? error.message : "未知错误"}`);
  process.exitCode = 1;
}
