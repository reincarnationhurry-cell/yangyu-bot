# 开发笔记（从 DSH 记忆搬出来的）

> 2026-10-21 从 DSH 工作区记忆（~/.dsh/memory/workspaces/<QQ_bot>/）搬到这里：
> 那份记忆每条 QQ 消息都会注入给「肥鱼」，工程笔记放在那里既拖慢回复、又让她的「记忆」变成工程日志。
> 开发时需要就读这份；以后的开发最好别在 QQ_bot 这个工作区里做（见 ops/README.md）。


## 2026-10-20
## DSH 新增 MCP server 的配置坑（2026-10-20 实测）

`~/.dsh/profiles/desktop/cordis.patch.yml` 里**新增**插件不能用 `- id: xxx` 直接写。
那样 patch 层会报 `patch: entry "xxx" not found` 并**静默跳过**，工具永远不出现，且不阻断启动，极难发现。
必须用 insert 形式：

```yaml
- insert:
    - id: mcp-bilibili
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: bilibili
        transport: stdio
        command: node
        args: ['/abs/path/to/server.js']
        cwd: /abs/path
        env: {...}
```

验证手段（不改真机）：
- `DSH_HOME=/tmp/xxx dsh --profile test --dump-config | grep -A16 <id>`
  真正的 desktop profile 被 Electron 独占，`--dump-config` 会报 `profile "desktop" is managed exclusively by the Electron application`，只能建临时 profile 验证。
- 每次 dump 都会打印 patch 告警到 stderr，务必检查有没有 `not found`。
- `dsh --profile test --dump-config-schema` 可查 entry/patch 的完整字段定义（patch 支持 `insert`）。

DSH 的 `@deepseek-ai/dsh-mcp-client` **不支持工具级白名单/黑名单**（无 allowedTools/denyTools 字段）。
要限制外部 MCP server 暴露的工具，只能改 server 自己（如劫持 registerTool），或在 `tools/pre-execute` 门禁上做文章。

配置改动会经 HMR 热加载进运行中的 App，无需重启；子进程会重启，工具名 `mcp__<serverName>__<rawToolName>`。
验证工具是否真的注册：读当前会话日志
`~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd`（zstdcat）里的 `request/header`，grep `mcp__`。

## 2026-10-20
## B站登录（QQ_bot，2026-10-20 已接通）

账号「在逃肥鱼公主」UID `3747573374388837`，Lv2。凭证在
`QQ_bot/bilibili-mcp/login/cookie.json`（**权限 600，必须保持，已在 .gitignore 里**）。
生效靠 `BILIBILI_COOKIE_FILE` 环境变量指向该文件；不配则 cookie 只存进程内存。

### 上游 v1.2.0 的登录 bug（已修，别再踩）
`bilibili-mcp-server` 的 `pollQrCode()` 成功分支读 `data.cookie_info`，
但 B站 `passport.bilibili.com/x/passport-login/web/qrcode/poll` **从不返回这个字段**，
凭证只在 `Set-Cookie` 响应头里（SESSDATA / bili_jct / DedeUserID）。
原实现即使扫码成功也只回「登录成功，但未获取到 Cookie 信息」并什么都不存。

修法：`apiGet()` 把原始 `Response` 挂到 `json.__res`，新增 `cookiesFromResponse()`
用 `res.headers.getSetCookie()` 解析，成功分支优先读头、保留 `cookie_info` 作兼容。

### 二维码
`qrcode/poll` 生成的二维码**有效期约 3 分钟**，超时返回 `86038 二维码已失效`。
生成后必须马上扫，隔几分钟就得重新生成。
上游 `tools/login.js` 只返回文本 URL（人扫不了），已加 `renderQrPng()` 渲染成 PNG 存到
`bilibili-mcp/login/qr-<key前12位>.png`，模型用 `present` 直接发图。

### 登录态带来的实际差异
- `bilibili_video_subtitle`：未登录基本都返回「没有可用字幕」；登录后能拿到带时间轴字幕。
  这是登录最实际的价值。
- `bilibili_notifications` / 自己的收藏夹 / 更完整的 UP 主数据：需要登录。

### 登录 vs 写操作的边界划分（重要设计决定）
「登录」属于**认证**，只写本地 cookie 文件，不向 B站发布任何内容 → **放行**。
「发评论/发弹幕/点赞/投币/收藏/关注/私信/投稿/下载」属于**内容写入** → **拦截**（8 个）。
别再把 `bilibili_login` 之类的塞进 WRITE_TOOLS，那会让只读模式下根本无法获得更全的读能力。

### cookie 过期
`SESSDATA` 约半年到期。`BILIBILI_AUTO_REFRESH` 现设 `'false'`（refresh_token 刷新链路未验证）。
过期表现：接口返回 `-101 账号未登录`。重跑一次扫码即可，无需改代码。

## 2026-10-20
## B站投币为什么不行（2026-10-20 定论，别再瞎试）

**根因是社区信用分，不是验证码。**
`/x/space/myinfo` 返回 `moral: 70`（满分 100）。B站投币有信用分门槛，
该号稳定返回 `-403 账号异常,操作失败`（更早期曾出现 `-401` + `verify_captcha_level3`）。
**每失败一次都可能继续掉分**，所以越试越差。

### 验证码路线走不通（别再研究）
B站滑块/点选验证码依赖浏览器执行 JS 并按鼠标轨迹算出加密 token，
纯 CLI 拿不到有效 token；截图给人工点也过不了校验。
而且该号根本没走到验证码那一层就被 -403 拒了。**不要为了"展示验证码给用户输入"花时间**。

### 已加客户端前置闸门
`patches/interaction.js` 里 `bilibili_video_coin` 默认直接拦截，不打 B站接口：
- 默认：返回友好说明（信用分 70、别重试、去养号）
- 放开：环境变量 `BILIBILI_COIN_GUARD=off`（会真的打接口）
两态均已实测。

### 养号方式
正常看视频、点赞、发弹幕，**别短时间批量操作**（一次点十个赞/连发五条评论才是掉分高危）。
信用分恢复后再试投币。

### 同一账号的其他能力都正常
点赞、评论、弹幕、收藏、关注、评论点赞、字幕、搜索、看详情 —— 全部实测通过。
所以"投币不行"不代表账号有问题，只是单项门槛。

### 顺带修的另一个坑：video_info 不输出 cid
发弹幕必须要 cid，但上游 `video_info` 输出里没有，模型只能猜（实测乱填返回 `-400`）。
已打补丁在输出里打印 `aid: xxx  cid: xxx` 一行。**以后发弹幕必须从这行取真实 cid。**

## 2026-10-20
## B站发动态 API（2026-10-20 打通，两个坑必看）

`POST https://api.bilibili.com/x/dynamic/feed/create/dyn?csrf=<bili_jct>`

### 坑 1：正文必须是 JSON，不能 form-urlencoded
`Content-Type: application/json`。
用 form 提交会**一直返回 `-400 请求错误`**，且不给任何线索，极易误判成"接口废弃"。

### 坑 2：csrf 放 URL，不要放 body
`?csrf=xxx` 在查询参数里。塞进 JSON body 会 `-111 CSRF 校验失败`。

### payload
```json
{
  "dyn_req": {
    "content": { "contents": [{ "raw_text": "正文", "type": 1, "biz_id": "" }] },
    "meta": { "app_meta": { "from": "create.dynamic.web", "mobi_app": "web" } },
    "scene": 1
  }
}
```
`scene: 1` = 纯文本动态（2=带图，4=转发）。成功返回 `code:0` + `data.dyn_id_str`，
地址 `https://t.bilibili.com/<dyn_id_str>`。

### 删除动态
`POST https://api.bilibili.com/x/dynamic/feed/operate/remove?csrf=<bili_jct>`
body 是 `{"dyn_id_str":"xxx"}`，同样 JSON + csrf 在 URL。
（`/x/dynamic/feed/space/del` 不存在，会返回 HTML 404 页面。）

### 验证方式
`GET /x/polymer/web-dynamic/v1/detail?id=<dyn_id>` 能查到正文和作者，
用它确认动态真的发出去了，别只信 create 的返回码。

### 上游 bilibili-mcp-server 没有发动态能力
`content.js` 只有 `user_dynamics`（读）、`article_info`、`user_articles`。
发动态是在 `diary/diary.mjs` 里自己实现的。

## 2026-10-20
type:dead-end
# 养鱼日记的模板化方案已废弃（2026-10-20）

## 走错的路
最初把日记做成「按字段拼装」：`add --type watch/like/thought` 分别存分类字段，
`compose` 按固定模板拼成：

```
【养鱼日记 · 日期】
今天在B站翻了翻「X」
看完了：
《Y》
顺手给 N 个视频点了赞
明天继续逛。
```

## 为什么错
- **每条都一个形状**，不管刷到什么内容，读起来像填好的表格。
- 固定开场（"今天在B站翻了翻"）和固定收尾（"明天继续逛"，还是四个候选轮换）
  是硬编码的，不是人话。
- 她的"感想"被塞进插槽里，变成结构的一部分，而不是表达本身。
- 本质问题：**代码替她决定了怎么说话**。

## 正确的做法
正文由她自己写，代码只负责发。
`node diary.mjs write "..."` 的内容就是最终正文，不加一个字的格式。
没有固定开头结尾、没有分类栏目，长短语气结构全随内容走。
38 字的短句也能正常发，不强行凑长。

`compose` 在没写整篇时，只把 thought/text 碎片按时间接起来；
动作类记录（点赞/观看）不参与拼装。只有动作没有文字时直接拒绝，不凑流水账。

## 教训
给 AI 做「表达类」功能时，**不要用代码搭框架让她填空**。
结构化字段适合存数据（便于统计/筛选），但不适合当产出物。
产出物要么由她整段写，要么就别硬拼。

## 2026-10-20
## B站私信 API（2026-10-20 打通，三个坑）

上游 `bilibili-mcp-server` **完全没有私信能力**（只有读通知），是本次自己实现的。

### 发送
`POST https://api.vc.bilibili.com/web_im/v1/web_im/send_msg`

**坑 1：要 Wbi 签名。** URL 查询参数带 `w_sender_uid` / `w_receiver_id` / `w_dev_id`，
用 `wbi.js` 的 `signWbi()` 签。不签 → `-400 请求错误`（无任何提示）。

**坑 2：正文是 form-urlencoded，不是 JSON。** 参数名带方括号：
`msg[sender_uid]`、`msg[receiver_id]`、`msg[receiver_type]=1`、`msg[msg_type]=1`、
`msg[msg_status]=0`、`msg[dev_id]`、`msg[timestamp]`、`msg[content]`。
其中 `msg[timestamp]` 是**秒级**时间戳（漏了会 -400），
`msg[dev_id]` 是 UUID v4（`crypto.randomUUID().toUpperCase()` 即可，每次随机）。
`msg[content]` 是 JSON 字符串：`{"content":"正文"}`。

**坑 3：csrf 要给两个字段。** `csrf` 和 `csrf_token` **两个都要传**，只传一个会 `-111 CSRF 校验失败`。

成功返回 `code:0` + `data.msg_key`。

### 读取
- 会话列表：`GET api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_id=0&build=0&mobi_app=web`
  → `data.session_list[]`，字段 `talker_id` / `unread_count` / `session_ts`（**微秒**）/ `last_msg`。
- 会话消息：`GET api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs?talker_id=<uid>&session_type=1&size=30&sender_device_id=1&build=0&mobi_app=web`
  → `data.messages[]`，需要按 `timestamp` 升序自己排（接口返回是倒序）。
  `content` 是 JSON 字符串，取 `.content`。
- 未读数：`/x/msgfeed/unread` 或 `session_svr/.../single_unread`。

## B站楼中楼回复

`POST /x/v2/reply/add`，和发一级评论是同一接口：
- 一级评论：`oid`（**必须是 aid 数字**，不是 bvid）+ `type=1` + `message` + `plat=1` + `csrf`
- 楼中楼：再加 `root`（根评论 rpid）+ `parent`（被回复的 rpid）

实测回复会正确挂在目标评论下面（用 `/x/v2/reply` 拉评论可看到 `replies[]` 里有它）。
`/x/v2/reply` 的 `oid` 同样要 aid。

## 2026-10-21
- keepawake 已验收通过: LaunchAgent state=running、arguments=-ims,电源断言 PreventSystemSleep/PreventUserIdleSystemSleep/PreventDiskIdle=1 且 PreventUserIdleDisplaySleep=0(屏幕仍可熄),KeepAlive 自愈(kill -9 后 5 秒自动拉起)。
- QQ 机器人回复延迟根因是 im-connect 插件 SessionMerger 的入站消息合并缓冲(默认 mergeTimeoutSecs=5 秒);消息结尾加 `!!` 触发 commit 立即 flush(`!!` 被剥离不显示),或改 ~/.dsh/profiles/desktop/cordis.patch.yml 的 im-connect mergeTimeoutSecs 为 1-2(工作区外,需用户手动改)。
- QQ 机器人回复常断在半句与 provider=trae 强相关(buddy 零截断);QQ 内发 `/model` 切回 buddy,根治改 cordis.patch.yml 的 agent-default-model provider 为 buddy。
- QQ 官方 Bot API 无流式接口,被动回复靠 msg_id,同一消息 5 分钟内最多回 4-5 次,无法做打字机效果。
- QQ 机器人凭据存于 ~/.dsh/.credentials.yaml 的 im_connect_qq_<appId>_appSecret;AppSecret 在 QQ 开放平台重置后,于 DSH Web GUI 设置→IM助理→QQ→手动配置更新,accountIdFor 按 appId 命中会覆盖同账号凭据而非新建账号。
- 养鱼面板以 launchd 常驻(~/Library/LaunchAgents/com.mikejam.yangyu-panel.plist,RunAtLoad=true + KeepAlive(SuccessfulExit=false),PANEL_PORT=8899);三种入口:~/Desktop/养鱼面板.command、终端 yangyu/养鱼(写入 ~/.zshrc)、http://127.0.0.1:8899。
- DSH 的 QQ 机器人被动响应、无消息不转;面板一键派活=往任务箱投任务,由机器人下次收到 QQ 消息时读箱执行。

## 2026-10-21（当日记录）

- 08:20 [kind:fact] keepawake 状态更新（2026-10-21 08:2x）：用户已在昨晚手动装好 LaunchAgent 并确认运行。检查发现两点问题：①装的 plist 参数是 -dims（会连屏幕一起常亮，费电），workspace 版已改为 -ims；②模型会话里尝试 bootout+bootstrap 重新注册失败（bootstrap 报 5: Input/output error，cp 到 ~/Library/LaunchAgents 与 chmod 均报 Operation not permitted，属沙箱限制）。结果：LaunchAgent 现为 NOT_LOADED，但手动 caffeinate -ims（pid 73345/73347）在跑，休眠仍被挡住，重启后失效。已更新 ops/README.md：给出用户终端里的重装命令组（cp + bootout + bootstrap + print 验证）并说明 -dims→-ims 的差异与当前状态。
- 08:22 [kind:fact] keepawake 最终验收通过（2026-10-21 08:3x）：用户在自己终端重装后，LaunchAgent com.mikejam.dsh-keepawake 状态 state=running，pid 73640，program=/usr/bin/caffeinate，arguments=-ims（只阻止系统休眠，不阻止屏幕熄）。电源断言实测：PreventSystemSleep=1、PreventUserIdleSystemSleep=1、PreventDiskIdle=1、PreventUserIdleDisplaySleep=0 —— 符合预期（屏幕仍可熄）。另清理了此前手动启动的重复 caffeinate 进程（案 73345/73347），现只剩 launchd 托管的一个。kill -9 73640 后 5 秒自动拉起新 pid 73640，KeepAlive 自愈验证通过。结论：熄屏掉线问题已彻底解决，开机自启+崩溃自愈有效。