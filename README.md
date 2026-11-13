# 智学网成绩监控

定时读取智学网学生成绩，支持 NAS Arcadia（Node.js）和 Cloudflare Worker 两种运行方式。首次执行保存当前基线，之后新增科目成绩或成绩更正时通过 Bark 通知。当前扫描最近学年考试列表第一页（最多 10 场）。

## NAS / Arcadia 部署

Arcadia 版本入口为 `scripts/arcadia-monitor.js`，使用 Node.js 22 或更高版本，无第三方运行时依赖，不需要 Cloudflare、KV、Wrangler 或 `npm install`。每次启动扫描一次并退出，由 Arcadia 定时调度。

1. 在 Arcadia 容器的持久化脚本目录中克隆本仓库，或通过 Arcadia 的仓库同步功能同步完整仓库：

   ```sh
   git clone https://github.com/admin05/zhixue-score-monitor.git
   ```

   保留 `package.json`、`scripts/` 和 `src/` 的相对目录结构。不要仅下载入口文件，也不要只把入口文件复制到另一个目录；它需要引用 `../src/` 中的模块。若使用自动仓库同步，只为 `scripts/arcadia-monitor.js` 创建定时任务，避免将 `src/` 或 `test/` 中的文件识别为任务。

2. 在 Arcadia 环境变量配置中添加：

   | 变量 | 必填 | 说明 |
   | --- | --- | --- |
   | `ZHIXUE_COOKIE` | 是 | 已登录智学网网页请求中的完整 Cookie，与 Worker 版相同 |
   | `BARK` | 建议 | Bark 设备 key，直接使用 Arcadia 中已有的变量；填写 key 本身，不填完整推送 URL |
   | `ZHIXUE_STATE_FILE` | 否 | 成绩快照的绝对路径，建议设到容器已映射到 NAS 的持久化数据目录 |

   默认快照位于仓库的 `data/score-snapshot.json`。确保该目录持久化且可写；仓库同步若会清理本地文件，应通过 `ZHIXUE_STATE_FILE` 将快照放在同步目录外。快照包含成绩，不要上传到 GitHub；默认 `data/` 已被 Git 忽略。Cookie 和 Bark key 只在 Arcadia 环境变量中配置，不写入脚本。

3. 在 Arcadia 新建执行任务，命令使用容器中仓库的实际绝对路径：

   ```sh
   node /实际仓库路径/zhixue-score-monitor/scripts/arcadia-monitor.js
   ```

   也可在仓库根目录手动运行 `npm run start:arcadia`。设置每 15 分钟执行一次：五字段 Cron 为 `*/15 * * * *`，包含秒的六字段 Cron 为 `0 */15 * * * *`；入口文件包含六字段 `Cron` 注释。首次先手动执行一次，确认日志显示“基线已建立”。

4. 每次运行发送一条 Bark 结果通知，包含脚本名、成功/失败状态和扫描摘要；成绩变化时附带最多 18 项变化摘要。首次运行只建立基线并推送运行成功摘要，不补发已有成绩。失败退出码为 `1`，成功为 `0`。

缺少 `BARK` 时记录提示并继续保存快照，该次成绩变化不会在补配 `BARK` 后补发。已经配置 `BARK` 但成绩变化通知发送失败时不推进快照，下次运行会重试。登录过期时在 Arcadia 更新 `ZHIXUE_COOKIE` 即可，不要删除成绩快照。

### Cookie 自动更新与持久化

Arcadia 版会接收智学网响应中的 `Set-Cookie`，包括本站重定向的中间响应，立即更新并保存到成绩快照旁的 `<快照路径>.cookies.json`，例如默认的 `data/score-snapshot.json.cookies.json`。同一次扫描的后续请求和下次定时运行都会使用更新后的 Cookie；即使后续查询或 Bark 通知失败，已保存的 Cookie 更新也会保留。更新时日志只显示条数，不输出 Cookie 值。

不需要新增环境变量。已有 `ZHIXUE_COOKIE` 用作首次导入来源；之后优先读取持久化会话。手动更新 `ZHIXUE_COOKIE` 后，脚本通过摘要识别变化，自动替换旧会话，无需删除成绩基线。Cookie 文件采用权限 `0600` 和临时文件替换写入，包含登录凭据，必须与成绩快照一起保存在持久化目录；`*.cookies.json` 已被 Git 忽略。

服务器下发的 Domain、Path、Max-Age 和 Expires 会用于匹配和过期删除。浏览器复制出来的 Cookie 请求头本身没有这些属性，因此初始导入按 `www.zhixue.com` 根路径处理，收到服务器同名更新后再采用服务器给出的属性。请求只跟随 `https://www.zhixue.com` 本站跳转，避免向其他站点发送登录凭据。

这项功能只接收服务器允许的会话更新，不会自动重新登录，也不能延长服务器规定的最长会话期限。已经失效的登录仍需在 Arcadia 更新 `ZHIXUE_COOKIE`。若 Cookie 文件损坏，脚本会报错并保留文件；可先将该文件移走，再使用环境变量重新导入，成绩快照无需删除。Cloudflare Worker 的 Cookie 配置方式不变。

快照采用临时文件写入后替换，读取到损坏的快照会报错并保留原文件。相同快照路径使用 `.lock` 目录避免任务重叠写入；若容器被强制停止且留下锁，确认旧进程已经停止后，移除快照旁的 `.lock` 空目录再重试。不要同时为同一个账号重复创建任务。

## 当前已确认的接口

实现参考 [anwenhu/zhixuewang-python](https://github.com/anwenhu/zhixuewang-python)：会话通过 `loginUserName` Cookie 构造 `uname`，调用 `/container/getCurrentUser` 检查会话；成绩查询使用短时 `XToken` 请求学年、考试列表和 `/zhixuebao/report/exam/getReportMain?examId=...`。参考项目近期说明智学网登录及部分接口发生变化，用户名密码登录仍可能要求浏览器完成人机验证，因此 Worker 使用手动登录后复制的 Cookie，不会尝试绕过验证。

## Cloudflare Worker 部署

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
