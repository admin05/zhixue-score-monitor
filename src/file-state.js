import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== 1 || !snapshot.grades ||
      typeof snapshot.grades !== "object" || Array.isArray(snapshot.grades)) {
    throw new Error("成绩快照格式异常，请检查或恢复备份，现有文件未被覆盖");
  }
  for (const exam of Object.values(snapshot.grades)) {
    if (!exam || typeof exam !== "object" || !exam.subjects ||
        typeof exam.subjects !== "object" || Array.isArray(exam.subjects)) {
      throw new Error("成绩快照科目格式异常，请检查或恢复备份，现有文件未被覆盖");
    }
  }
  return snapshot;
}

export function createFileState(filePath) {
  const path = resolve(filePath);
  return {
    async get(_key, type) {
      let contents;
      try {
        contents = await readFile(path, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw new Error(`无法读取成绩快照 (${error.code ?? "unknown"})`);
      }
      let parsed;
      try {
        parsed = JSON.parse(contents);
      } catch {
        throw new Error("成绩快照不是有效 JSON，现有文件未被覆盖");
      }
      validateSnapshot(parsed);
      return type === "json" ? parsed : contents;
    },
    async put(_key, value) {
      validateSnapshot(JSON.parse(value));
      await mkdir(dirname(path), { recursive: true });
      const temporaryPath = `${path}.${process.pid}.tmp`;
      try {
        await writeFile(temporaryPath, value, { encoding: "utf8", mode: 0o600 });
        await rename(temporaryPath, path);
      } finally {
        await rm(temporaryPath, { force: true });
      }
    },
  };
}

export async function withFileStateLock(filePath, task) {
  const lockPath = `${resolve(filePath)}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("成绩快照已锁定：请等待上次运行结束；若进程已被强制停止，请移除快照旁的 .lock 空目录后重试");
    throw error;
  }
  try {
    return await task();
  } finally {
    await rm(lockPath, { recursive: true });
  }
}
