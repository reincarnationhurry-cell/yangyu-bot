# 🐟 云养鱼：蓝色大肥鱼

把 DeepSeek 养成一个住在 QQ 里、会自己刷 B站 的小伙伴。

- **QQ 里聊天**：通过 DeepSeek Harness（DSH）的 QQ 机器人接入，有自己的性格、表情包和语音（`AGENTS.md`）。
- **自己刷 B站**：接上 B站 MCP，能搜视频、看评论、点赞、评论、发弹幕、回私信、发动态。
- **自动养号**：每天在几个时辰里随机挑时间，像真人一样刷一会儿 B站：用播放心跳真的「看」（会留下观看记录）、随缘点赞、每天分享，稳稳拿每日经验。
- **养鱼面板**：本地 Web 面板，看她的活动时间线、经验进度，替她回评论和私信，审 AI 起草的内容，给她派活。

<p align="center"><i>面板截图：总览 / 活动记录 / 自动养号 / 刷视频 / 消息 / 待审 / 日记</i></p>

## 目录

```
.
├── AGENTS.md            她的人设与行为守则（DSH 工作区的系统提示）
├── panel/               养鱼面板 + 自动养号 + B站操作库 + 机器人 CLI   → panel/README.md
├── bilibili-mcp/        vendored bilibili-mcp-server + 补丁 + DSH 配置示例 → bilibili-mcp/README.md
├── diary/               养鱼日记（发 B站 动态）                          → diary/README.md
├── stickers/            她的表情包（INDEX.md 是清单）
└── tts/                 语音：macOS say → 带音频的 mp4（QQ 能发）
```

## 快速开始

需要 macOS、Node.js ≥ 22（MCP 服务需要；面板本身 ≥ 18 就行）、DSH 桌面版（只用面板和自动养号的话不需要）。

```bash
# 1. 装 B站 MCP 并打补丁
cd bilibili-mcp && npm install && node apply-patch.mjs && cd ..

# 2. 登录 B站（建议单独注册一个机器人号）
#    在 DSH 里让她调 bilibili_login → 扫二维码 → bilibili_login_check，
#    凭证会落到 bilibili-mcp/login/cookie.json（已 gitignore）。
#    DSH 接入配置见 bilibili-mcp/dsh-config.example.yml

# 3. 启动面板（launchd 托管，登录自启）
./panel/install-launchd.sh
open http://127.0.0.1:8899
```

然后在面板「自动养号」里选时辰、打开总开关。

## 关于养号：说实话版

B站等级只看经验，而每日经验是**有上限**的：

| 来源 | 每天 |
|---|---|
| 登录 | 5 |
| 观看视频 | 5 |
| 分享视频 | 5 |
| 投币 | 每枚 10，最多 50 |

Lv6 要 28800 经验。不投币每天最多 15，大约要 5 年；每天投 1 枚币（新号每天只送 1 枚）是 25，大约 3 年。
**刷得再多也不会更快，只会更像机器人。** 这个项目的目标是：每天稳稳拿满能拿的那部分，看起来像个普通人。

另外几点：

- 面板上的「节操值 70」是正式会员的常见值，不是「100 分只拿了 70」。
- 一次性经验（绑邮箱 +20、密保问题 +30、实名 +50）要你自己去 B站账号设置里完成，脚本不碰。
- 投币接口对脚本很敏感。这里的策略是**失败一次就永久上锁**，只能在面板手动解锁。

## 风险与免责

这是个人兴趣项目，用的都是 B站 网页端非公开接口，随时可能变。自动化操作可能违反 B站 用户协议，
导致限流、禁言甚至封号。请只用**专门注册的小号**，自己判断、自己承担风险。
别拿它刷量、引流、发广告、骚扰别人。

## 致谢

- [Iseenope/bilibili-mcp-server](https://www.npmjs.com/package/bilibili-mcp-server)（MIT）
- [SocialSisterYi/bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect)：B站 接口的社区文档

## License

MIT
