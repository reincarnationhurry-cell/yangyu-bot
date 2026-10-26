# 让 DSH 帮你部署一条「蓝色大肥鱼」

这份是写给 **DeepSeek Harness（DSH）** 看的部署手册，也写给你看。你只要在 DSH 里说一句：

> 按 https://github.com/reincarnationhurry-cell/yangyu-bot/blob/main/docs/SETUP-DSH.md 帮我部署，我要做的步骤停下来告诉我。

每一步都标了谁来做：

- 🤖 **DSH 做**：跑命令、改配置，做完自己核对。
- 🙋 **你来做**：扫码、填密钥、装软件这些，DSH 替不了你（也不该替你）。DSH 到这里要停下，说清楚去哪、点什么，等你说「好了」再往下。

先说清楚：**只能在 macOS 上跑**（launchd 托管面板、`say` 合成语音、系统通知都是 Mac 的）。Windows / Linux 暂时不行。
它也不是一个网页或 EXE，是一套在你电脑上常驻的 Node 服务 + 本地面板 `http://127.0.0.1:8899`。

---

## 给 DSH 的几条规矩

1. **别让号主把密钥、Cookie、密码贴进聊天。** 模型 Key、ModelScope 令牌都在面板网页里填，存在本机 `panel/data/secrets.json`；B站、QQ 都是手机扫码。
2. 仓库克隆到 `~/yangyu-bot`，**别克隆进你现在这个工作区**：仓库根目录的 `AGENTS.md` 是她的人设，放进工作区你会变成她，还会把部署的工程笔记混进她的记忆。
3. 每个 🙋 步骤停下来等号主回话，别跳过、别猜「应该好了」。
4. 每个 🤖 步骤后面都有「核对」，没过就停下来把报错原样告诉号主，别自己去改仓库代码。
5. Docker 镜像、Homebrew 这类第三方程序不要替号主下载安装，告诉他链接让他自己装。

---

## 0. 检查环境 🤖

```bash
uname -s                 # 必须是 Darwin
node -v                  # 要 ≥ 22
git --version
ffmpeg -version | head -1   # 语音要用
```

- 不是 macOS：告诉号主跑不了，结束。
- 🙋 缺 Node ≥ 22：让号主去 https://nodejs.org 装 LTS 版。
- 🙋 缺 ffmpeg：有 Homebrew 的话让号主自己跑 `brew install ffmpeg`；没有就先装 Homebrew（https://brew.sh）。
- 可选：Chrome（「等你帮她点」那个功能要用，没有也能跑）。

## 1. 拿到代码 🤖

```bash
git clone https://github.com/reincarnationhurry-cell/yangyu-bot.git ~/yangyu-bot
cd ~/yangyu-bot
```

后面所有命令都在 `~/yangyu-bot` 里跑。

## 2. 装 B站 能力 🤖

```bash
cd ~/yangyu-bot/bilibili-mcp && npm install && node apply-patch.mjs && node apply-patch.mjs --check
```

核对：最后的 `--check` 退出码是 0（0 = 补丁已打上，1 = 没打上）。

## 3. 启动面板 🤖

```bash
cd ~/yangyu-bot && ./panel/install-launchd.sh
sleep 3 && curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8899
```

核对：打印 `200`。面板交给 launchd 托管了，开机自启、崩了自动拉起。
不行就看 `panel/data/panel.err.log`。然后让号主打开 http://127.0.0.1:8899 。

## 4. 给她一个脑子 🙋

面板 →「自动养号」→「模型设置」：填一个 **OpenAI 兼容** 的接口地址、API Key、模型名（可以点「列出可用模型」选），保存。
DeepSeek 官方开放平台、或者 DSH 本地网关都行。

> 不填也能跑，只是她不会自己想事情，只会按概率随缘刷；QQ 小号聊天也要靠这个。

## 5. 给她一个 B站 号 🙋

**强烈建议专门注册一个新号**，别用自己的号（自动化有被限流、封号的风险，见 README「风险与免责」）。

面板顶上会挂红条「没登录」，点「扫码登录」，用手机 B站 App **登录那个新号** 扫码确认。

核对 🤖：刷新面板，总览能看到头像和等级。

## 6. 打开自动养号 🙋

面板 →「自动养号」：选几个时辰、填几个兴趣关键词、（可选）在「她的窗」填城市，打开总开关。

到这一步，她已经会自己在 B站 过日子了。下面是接 QQ。

## 7. 接 QQ（二选一）

### A. 她自己的 QQ 小号（推荐：能主动找你、发真语音）

非官方框架，**小号可能被冻结**，用一个专门的小号。

1. 🙋 装 Docker：[OrbStack](https://orbstack.dev)（轻，推荐）或 Docker Desktop，装好打开一次。
2. 🤖 生成 WebUI 密钥并启动 NapCat：

   ```bash
   cd ~/yangyu-bot/panel/qq/napcat
   [ -f .env ] || echo "WEBUI_TOKEN=$(openssl rand -hex 16)" > .env
   docker compose up -d && docker compose ps
   ```

   核对：`napcat` 状态是 running。第一次要拉镜像，慢一点正常。
   然后告诉号主密钥在 `~/yangyu-bot/panel/qq/napcat/.env` 里（让他自己打开看，别念出来）。
3. 🙋 打开 http://127.0.0.1:6099/webui ，输入密钥，用 **小号** 的手机 QQ 扫码登录。
   在「网络配置」里确认有一个 WebSocket 服务器、端口 3001、消息格式 **array**。
4. 🙋 小号加你的大号为好友。
5. 🙋 面板 →「自动养号」→「💬 QQ 连接」：用哪个选 **她自己的 QQ 小号**，填你大号的 QQ 号，地址保持 `ws://127.0.0.1:3001`，保存，点「用小号发一条测试」。

核对：你的大号收到测试消息。详细说明见 `panel/qq/README.md`。

### B. DSH 的 QQ 官方机器人

官方渠道更稳，但只能在你说话后一小时内回，不能主动找你。

1. 🙋 在 DSH 设置 →「IM 助理」里接好 QQ 机器人，让 QQ 会话的工作目录指向 `~/yangyu-bot`（这样 `AGENTS.md` 就是她的人设）。
2. 🤖 把 B站 MCP 接进 DSH：把 `bilibili-mcp/dsh-config.example.yml` 的内容追加到 `~/.dsh/profiles/desktop/cordis.patch.yml`，
   `<QQ_BOT_DIR>` 全部换成 `~/yangyu-bot` 的**绝对路径**（`echo ~/yangyu-bot` 看一下）。改之前先备份原文件。
3. 🙋 重启 DSH。在 QQ 里跟她说「去B站搜搜猫猫」，她能回出视频就通了。

## 8. 外挂（可选）

只有 A 路线（小号）需要，不装也能聊天。

- **查资料、看图**：要桌面版 DSH 开着。
  1. 🙋 在 DSH 插件市场装 `dsh-free-search`。
  2. 🤖 `cd ~/yangyu-bot && ./panel/qq/dsh-profile/setup.sh`，核对最后打印 `✓ 她专用的 DSH 配置好了`。
- **做新表情包**：
  🙋 ModelScope 账号绑定阿里云并实名，在 https://modelscope.cn/my/myaccesstoken 生成令牌，填进面板「QQ 连接 → ModelScope 访问令牌」。

## 9. 收尾核对 🤖

逐条告诉号主结果：

- [ ] `curl http://127.0.0.1:8899` 返回 200
- [ ] 面板总览有 B站 头像和等级
- [ ] 自动养号总开关打开、选了时辰
- [ ] QQ 发一句话她能回（A 或 B）

全过了就告诉号主：「好了，去 QQ 跟她打个招呼吧。」之后别再待在这个仓库里干活。

---

## 出问题了

| 现象 | 看哪 |
|---|---|
| 面板打不开 | `panel/data/panel.err.log`；重启：`launchctl kickstart -k gui/$(id -u)/com.$(whoami).yangyu-panel` |
| B站 掉登录 | 面板红条 → 扫码登录（扫她的号） |
| 点赞 / 分享被拒 | 正常，B站 风控，面板会自动暂停那个动作，见 README「关于养号」 |
| 小号没连上 | `cd ~/yangyu-bot/panel/qq/napcat && docker compose logs -f` |
| 想卸载 | `./panel/install-launchd.sh uninstall`，小号的话再 `docker compose down` |
