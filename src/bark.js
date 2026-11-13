export async function sendBarkNotification(key, title, body) {
  if (!key?.trim()) {
    console.warn("未设置 BARK 环境变量，跳过本次运行通知");
    return;
  }

  let response;
  try {
    response = await fetch("https://api.day.app/push", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ device_key: key.trim(), title, body, group: "智学网成绩监控" }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const code = error?.cause?.code ?? error?.name ?? "unknown";
    throw new Error(`Bark 连接失败 (${code})`);
  }
  if (!response.ok) throw new Error(`Bark 推送失败 (${response.status})`);
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("Bark 响应不是有效 JSON");
  }
  if (result?.code !== 200) throw new Error(`Bark 推送未成功 (code=${result?.code ?? "unknown"})`);
}
