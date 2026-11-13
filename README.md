# 智学网成绩监控

Cloudflare Worker 定时读取智学网学生成绩；首次执行只保存当前基线，之后新增科目成绩或成绩更正时通过 Bark 通知。当前扫描最近学年考试列表第一页（最多 10 场）。

## 当前已确认的接口

实现参考 [anwenhu/zhixuewang-python](https://github.com/anwenhu/zhixuewang-python)：会话通过 `loginUserName` Cookie 构造 `uname`，调用 `/container/getCurrentUser` 检查会话；成绩查询使用短时 `XToken` 请求学年、考试列表和 `/zhixuebao/report/exam/getReportMain?examId=...`。参考项目近期说明智学网登录及部分接口发生变化，用户名密码登录仍可能要求浏览器完成人机验证，因此 Worker 使用手动登录后复制的 Cookie，不会尝试绕过验证。

## 部署

需要 Node.js 和 Wrangler 4，以及一个 Cloudflare 账号。

1. 安装依赖并登录 Cloudflare：

   ```sh
   npm install
   npx wrangler login
   ```

2. 创建 KV namespace，并将返回的 ID 填入 `wrangler.jsonc` 的 `STATE` 绑定：

   ```sh
   npx wrangler kv namespace create STATE
   ```

3. 保存智学网 Cookie 和 Bark key 为 Worker Secrets：

   ```sh
   npx wrangler secret put ZHIXUE_COOKIE
   npx wrangler secret put BARK_KEY
   ```

   Cookie 必须从已登录的智学网网页请求中完整复制，直接粘贴，不要手动添加字段。代码会原样使用当前浏览器 Cookie；若存在旧式 `loginUserName` 字段，则兼容性地补上 `uname`。不要将 Cookie、密码、Bark key 或成绩写入仓库。

4. 部署 Worker：

   ```sh
   npx wrangler deploy
   ```

Cron 每 15 分钟运行一次。可以用 `npx wrangler tail` 查看不含成绩明细的运行摘要。首次成功运行只建立基线，不会补发已有成绩。

## 本地检查

```sh
npm test
npm run check
```

## GitHub Actions 连通性测试

在 GitHub 仓库 Settings → Secrets and variables → Actions 中添加仓库 Secret `ZHIXUE_COOKIE`，值为从已登录智学网页面复制的完整 Cookie。然后在 Actions 页面手动运行 `Zhixue connectivity test`。该测试只确认学生账号、登录令牌、学年和考试列表接口可访问，不读取成绩详情，也不保存 Cookie 或成绩。运行摘要只包含学年数和考试场数。

要在 Cloudflare 实际验证登录与查询，需要提供有效的 Cloudflare 部署权限并将智学网 Cookie 设为 Secret；本仓库不保存这些凭据。
