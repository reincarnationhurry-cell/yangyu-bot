# B站能力接入（QQ 机器人「蓝色大肥鱼」）

给 QQ_bot 工作区的机器人接上 B站只读能力。装好后她能自己搜视频、看视频详情、
翻评论、看弹幕/字幕、看热搜热榜、查 UP 主资料。

## 结论：用了哪个方案

**选 `Iseenope/bilibili-mcp-server`（npm 包 `bilibili-mcp-server@1.2.0`）**，
没用首选的 `adoresever/bilibili-mcp`。

两者都实测跑通过（都能 `list_tools` 并成功返回真实数据），对比如下：

| | adoresever/bilibili-mcp | **Iseenope/bilibili-mcp-server** |
|---|---|---|
| 语言/运行时 | Python 3.10+（FastMCP） | Node.js 22+（官方 MCP SDK） |
| 工具数 | 27 | 31（只读闸门后 20） |
| 部署 | 需 clone + venv + pip 装 `bilibili-api-python` 等 | 一个 npm 包，无第三方 B站库，自带签名实现 |
| **依赖坑** | `mcp>=1.0.0` 无上界，现在会装到 mcp 2.x，**`FastMCP` 已改名 → 直接启动失败**，必须手动钉 `mcp<2` | 依赖干净 |
| **匿名可用性** | 评论/视频详情/弹幕/字幕**全部强制要登录**（`get_cred()` 直接抛"未登录B站"），只有搜索和热榜能匿名用 | 除字幕外，搜索/详情/评论/弹幕/热榜**匿名全部可用**（修一个 WBI bug 后） |
| 写操作 | 发评论、发动态、传视频、发私信 | 发评论、发弹幕、点赞投币收藏、关注、私信、下载 |
| 维护 | 2026-03 后无提交 | 2026-07 发布 1.2.0，仍在更新 |

决定性理由是**匿名可用性**：用户明确要求"先只做读"。adoresever 版即使只读，
评论/详情/弹幕也都卡在登录上，等于读能力砍掉一半；Iseenope 版不登录就能读绝大部分内容。
另外 Python 版那个 `mcp<2` 的坑会让它下次环境重建时直接崩，不适合挂在长跑的机器人上。

## 安装位置

本地 vendor 到工作区，**不用全局 npx**（避免升级漂移、离线也能起）：

```
QQ_bot/bilibili-mcp/
├── package.json                    # 锁定 bilibili-mcp-server@1.2.0
├── apply-patch.mjs                 # 补丁脚本（可重复执行 / --check 自检）
└── node_modules/bilibili-mcp-server/dist/   # 打过补丁的产物
```

DSH 侧配置在 `~/.dsh/profiles/desktop/cordis.patch.yml`，条目 id = `mcp-bilibili`。

## 两个必需补丁

### 1. 匿名 WBI 修复（不修就没法用）

`dist/api/wbi.js`：B站 `/x/web-interface/nav` 未登录时返回 `code=-101`（账号未登录），
但 `data.wbi_img` 里的密钥**是有效的**。原实现只要 `code !== 0` 就抛错，
导致匿名态下所有 WBI 接口（搜索、视频详情、用户信息、用户视频）全部失败。

改成只校验 `wbi_img` 是否存在。修完后匿名搜索/详情/评论/弹幕/热榜全部正常。

### 2. 登录凭证解析修复（不修就登录不了）

`dist/api/login.js`。上游 `pollQrCode()` 成功分支读的是 `data.cookie_info`，
但 B站 passport 的 `qrcode/poll` 接口**从不返回这个字段** —— 凭证只通过 `Set-Cookie`
响应头下发（`SESSDATA` / `bili_jct` / `DedeUserID`）。

后果：即使扫码成功，原代码也只会回「登录成功，但未获取到 Cookie 信息」，然后什么都不保存。

修法：`apiGet()` 保留原始 `Response`（挂在 `json.__res` 上），新增 `cookiesFromResponse()`
用 `headers.getSetCookie()` 解析；成功分支优先用响应头，仍保留 `cookie_info` 作为兼容回退。

### 3. 二维码渲染成图片

`dist/tools/login.js`。上游只返回一串 URL，人没法直接扫。补丁把 URL 渲染成 PNG：

```
QQ_bot/bilibili-mcp/login/qr-<key前12位>.png
QQ_bot/bilibili-mcp/login/LATEST_QR.txt   # 记录最新一张的路径/URL/key
```

依赖 `qrcode` 包（已加到 `package.json`）。没装则自动退化回只返回 URL，不影响登录本身。

模型侧拿到路径后用 `present` 直接把图发给用户扫。

### 4. 服务端只读闸门（安全边界）

DSH 的 `dsh-mcp-client` **没有按工具白名单过滤的能力**，所以"只读"不能靠 DSH 配置实现，
必须由服务端保证。补丁在 `dist/index.js` 里劫持 `server.registerTool`：

```js
const READONLY = process.env.BILIBILI_MCP_READONLY !== 'false';
server.registerTool = (name, ...rest) =>
  WRITE_TOOLS.has(name) ? (blockedTools.push(name), undefined) : originalRegisterTool(name, ...rest);
```

效果：写工具**根本不进 `tools/list`**，模型既看不到也调不到，
不依赖提示词约束，无法被越狱/注入绕过。

被屏蔽的 8 个**内容写入**工具：
`bilibili_reply`、`bilibili_delete_comment`、`bilibili_like_comment`、`bilibili_send_danmaku`、
`bilibili_user_follow`、`bilibili_user_unfollow`、
`bilibili_video_download`、`bilibili_article_download`

> **登录类工具不受拦截**（`bilibili_login` / `bilibili_login_check` / `bilibili_refresh_cookie`）。
> 它们只写本地 cookie 文件，不向 B站发布任何内容，属于「认证」而非「内容写入」。
> 允许登录是为了让读能力更全 —— 字幕、部分评论排序、UP主数据等需要登录态。

## 登录（已接入）

扫码登录后凭证存到 `bilibili-mcp/login/cookie.json`（权限 600，已加 `.gitignore`）。

流程：`bilibili_login` 出二维码 → 扫码确认 → `bilibili_login_check` 完成落盘。

**二维码有效期只有约 3 分钟**（B站限制，超时返回 `86038 二维码已失效`），
生成后要尽快扫，否则得重新生成。

`BILIBILI_COOKIE_FILE` 环境变量指向该文件；不配的话 cookie 只存内存，
MCP 子进程一重启（配置改动触发 HMR 就会重启）登录态就丢了。

登录后 `bilibili_video_subtitle`
从「没有可用字幕」变成能正常返回带时间轴的字幕。

## 升级 / 重装后必须做的事

`npm install` 或升级会覆盖 `node_modules`，四个补丁都会丢。重跑：

```bash
cd bilibili-mcp
node apply-patch.mjs          # 打补丁（幂等，已打过的会跳过）
node apply-patch.mjs --check  # 只检查：0=都打好了，1=有缺失
```

补丁脚本已验证「还原成上游原版 → 重新打上」的往返可复现，且 `--check` 能正确报出缺失。

如果上游版本改了代码导致锚点找不到，脚本会明确报"找不到锚点"并退出，
需要人工核对后更新 `apply-patch.mjs` 里的 `find`/`replace`。

## 现在有哪些工具（23 个：20 只读 + 3 登录）

```
bilibili_search              搜视频（order: totalrank/click/pubdate/dm/stow/scores）
bilibili_video_info          视频详情（播放/点赞/投币/收藏/分享）
bilibili_video_comments      评论列表
bilibili_video_danmaku       弹幕
bilibili_video_subtitle      字幕（不是所有视频都有）
bilibili_hot                 热门视频
bilibili_search_hot          热搜词
bilibili_user_info           UP主资料
bilibili_user_videos         UP主投稿列表
bilibili_user_dynamics       UP主动态
bilibili_user_favorites      收藏夹
bilibili_user_followings     关注列表
bilibili_user_followers      粉丝列表
bilibili_article_info        专栏详情
bilibili_user_articles       UP主专栏列表
bilibili_live_info           直播间信息
bilibili_live_screenshot     直播截图
bilibili_notifications       未读消息概览
bilibili_detect_replies      新回复检测
bilibili_download_list       已下载列表
```

模型侧名字是 `mcp__bilibili__<tool>`。

## 写操作（已开放）

建议给机器人**单独注册一个 B站账号**（别用自己的主号），
已明确授权自由发评论/关注/点赞/投币，只要符合社区文化。
因此 `BILIBILI_MCP_READONLY` 现为 `'false'`，34 个工具全部注册。

若要收回：改回 `'true'` 即恢复服务端硬拦截（8 个内容写入工具不进 `tools/list`）。

Cookie **不用另外配** —— 已经扫码登录并落在 `bilibili-mcp/login/cookie.json` 了。
改完 DSH 会热加载（HMR），不用重启 App；随后 `tools/list` 里会多出发评论/弹幕等工具。

> 风险提醒：放开后机器人能用 `bilibili_reply` 以**你本人账号**发评论。
> B站对第三方客户端发评论有风控，频率过高会触发验证甚至封禁。
> 建议放开时同步在 `AGENTS.md` 里收紧调用策略（例如每次发评论前必须先向用户确认内容）。

## 验证方法

```bash
# 1. 补丁状态
cd QQ_bot/bilibili-mcp && node apply-patch.mjs --check

# 2. 合成配置里能看到条目（临时 DSH_HOME，不会影响真机）
# 3. 真机验证：直接让机器人「搜一下B站上的XXX」
```

实测通过的真实调用：
- 匿名态：`bilibili_search`（"周易 六十四卦"）、`bilibili_video_info`、`bilibili_video_comments`、
  `bilibili_hot`、`bilibili_video_danmaku`
- 登录态：`bilibili_login` + `bilibili_login_check` 全流程、`bilibili_video_subtitle`（返回带时间轴字幕）、
  `bilibili_notifications`、`bilibili_user_info`

持久化验证：新起一个进程，只靠 `cookie.json` 加载凭证调 `nav` 接口，
返回 `code:0 / isLogin:true`，确认重启不丢登录态。

## 已知限制

- **字幕需要登录态**：未登录时 `bilibili_video_subtitle` 基本都返回"该视频没有可用字幕"；
  登录后可正常拿到带时间轴的字幕。即便如此，仍有一部分视频本身没有字幕文件。
- **Cookie 会过期**：`SESSDATA` 有效期约半年，过期后需重新扫码。
  `BILIBILI_AUTO_REFRESH` 目前设为 `'false'`（refresh_token 刷新流程未验证）；
  若真过期了，重跑一次扫码登录即可。
- **投币已加前置闸门（默认拦截）**：该号社区信用分实测 **70 分**（满分 100），
  B站投币有信用分门槛，服务端稳定返回 `-403 账号异常,操作失败`（早期也出现过
  `-401` + `verify_captcha_level3`）。关键风险是**每失败一次都可能继续掉分**，
  越试越差。因此 `patches/interaction.js` 在客户端直接拦下投币，不消耗尝试次数。
  - 想临时试一次：设环境变量 `BILIBILI_COIN_GUARD=off`（注意会真的打 B站接口）。
  - 信用分养回来后：确认投币能通，再把闸门去掉或保持 off。
  - 养号方式：正常看视频/点赞/发弹幕，**别短时间批量操作**。
  - 验证码那条路走不通：B站验证码依赖浏览器执行 JS 与鼠标轨迹，CLI 拿不到有效 token，
    截图给人工点也过不了，不要在这上面费劲。
- **点赞/评论/关注正常**：已实测 10 个视频点赞全部生效（`has/like` 返回 1）、
  3 条评论成功发布并可在评论区查到、关注状态 `attribute=2`。
- **风控**：短时间内高频调用会返回 `-799 请求过于频繁` / `-412`。
  机器人侧已在 AGENTS.md 里约定了退避策略。
- **`bilibili_user_info` 偶发 -799**：这是 B站对该接口本身的限流，不是配置问题。
- **下载类工具被屏蔽**：`bilibili_video_download` 会落盘大文件，只读模式下一并关掉。
