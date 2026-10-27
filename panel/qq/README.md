# 她自己的 QQ 小号

不再靠 DSH + dsh-im-connect 插件 + QQ 官方机器人。她用你给她注册的 QQ 小号，面板自己当大脑：

```
你的 QQ ──私聊──▶ 小号（Docker 里的 QQ + NapCat）──OneBot WebSocket──▶ 养鱼面板 ──▶ DeepSeek
                                                          ◀── 回复 / 表情包 / 语音 ──
```

和官方机器人比：

| | 官方机器人（DSH 插件） | 小号（NapCat） |
|---|---|---|
| 主动找你 | ✗ 只能在你说话后一小时内回 | ✓ 随时，汇报、提醒、分享不用等你开口；白天隔久了还会自己找你 |
| 语音 | 封面 + 音频的 mp4 | 真的语音条 |
| DSH 升级 | 插件跟不上就掉线 | 不依赖 DSH |
| 风险 | 官方渠道，安全 | 非官方框架，**小号可能被冻结** |

## 装（Docker 版 NapCat）

> 别往 Mac 版 QQ 里注入 NapCat：2026-10-24 实测（QQ 7.0.2-53644 + NapCat 4.18.41），NapCat 一改写 QQ 安全模块在内存里的代码，
> macOS 就以「代码签名无效」把它杀掉（崩溃报告：`SIGKILL (Code Signature Invalid)`，崩在 `wrapper.node` 的 `libsecO3Init`）。
> NapCat 维护者也说 macOS 支持不全、建议用 Docker（[NapCatQQ#2066](https://github.com/NapNeko/NapCatQQ/issues/2066)）。
> 已经用 Mac 安装器装过的，先用安装器卸载、或者重装一遍官方 QQ，把 QQ 恢复原样（不然你自己的 QQ 也打不开）。

Docker 和镜像都是你自己装、自己拉（面板不替你下载运行第三方程序）。

1. **装 Docker**：[OrbStack](https://orbstack.dev)（轻，推荐）或 [Docker Desktop](https://www.docker.com/products/docker-desktop/)，装好打开一次。
2. **启动 NapCat**（配置已经在 `panel/qq/napcat/` 里写好了，WebUI 密钥随机生成在同目录 `.env`，不进 git）：

   ```bash
   cd panel/qq/napcat && docker compose up -d
   ```

   第一次要拉 `mlikiowa/napcat-docker` 镜像（[NapCat-Docker](https://github.com/NapNeko/NapCat-Docker)），等它跑起来。
3. **登录小号**：打开 `http://127.0.0.1:6099/webui`，密钥是 `.env` 里 `WEBUI_TOKEN=` 后面那串，然后用小号的手机 QQ 扫码。
4. **看 WebSocket**：`MODE: ws` 已经让它在 3001 开了正向 WebSocket。在 WebUI「网络配置」里确认有一个 WebSocket 服务器、端口 3001，
   消息格式 **array**；它设了 token 就记下来（没设也行，端口只绑在本机）。
5. 小号加你的大号为好友（私聊要是好友）。
6. 面板 → 自动养号 →「💬 QQ 连接」：
   - 用哪个：**她自己的 QQ 小号**
   - 填你的 QQ 号；NapCat 地址保持 `ws://127.0.0.1:3001`；有 token 就填 → 保存
   - 点「用小号发一条测试」，QQ 收到就通了
   - 点「从 DSH 带记忆过来」：把 DSH 记忆里关于你的事提炼过来（只读，不动 DSH 的文件；工程笔记不带）
7. 想只留一个她：DSH 设置 →「IM 助理」把 QQ 渠道关掉。不关也行，那是另一个号，两边各聊各的。

容器设了 `restart: unless-stopped`：Docker 开着它就开着，电脑重启后 OrbStack / Docker Desktop 起来它就跟着起来。

## 少踩坑

- **镜像别乱升**。容器里的 QQ 和 NapCat 是一起打包好的，能用就别急着 `pull`；要升级先看 NapCat 的更新说明，
  想锁版本就把 `latest` 换成具体版本号。面板每 5 分钟查一次小号连没连上，断了顶上挂红条、弹 macOS 通知。
- 小号平时也用手机正常登一登、别只挂在电脑上；别拿它加群、加陌生人、群发。她只理你的私聊，别人私聊不回。
- 被冻结了按 QQ 的提示解冻，或者换回「官方机器人」（设置里切一下就行，两条路都留着）。

## 她在这边怎么想事情

- 人设直接读 `AGENTS.md`：性格、说话方式、记忆习惯、互动原则、红线这几节（`## 一`、`## 二`、`## 五`、`## 六`、`## 七`），
  去掉 DSH 里跑命令的那些行。改人设还是改 `AGENTS.md`，两边一起生效；**别改这几节的标题编号**，这边靠它找。
- 每次回你，带上：此刻的天（`sky.mjs`）、她的心情和「最近的我」、她今天刷 B站 的经历、跟你这句话有关的回忆、
  她记得的关于你的事、最近 3 天的聊天（`/new` 可以清掉）。
- 她能用的工具（都在进程里直接调，不跑命令，所以快）：发表情包、发语音、记住 / 改正关于你的事、翻记忆、
  把 B站 的活交给后台、看后台做到哪了、叫停 / 恢复、看待审、处理待审；查资料、做新表情交给 DSH（见下面「外挂」）。
- 你连着发几条，她等 2.5 秒没新的再一起回；你发的图她会先看一眼再回；你发的语音她在本机听写成文字再回（要装 mlx-whisper，没装就老实说听不了）。
- 她发的语音按顺序试：本机的 GPT-SoVITS（克隆的声音）→ edge-tts（微软的神经网络音色，要联网）→ macOS 的 say。都是可选的，自己装：

  ```bash
  uv tool install edge-tts      # 好听的声音
  uv tool install mlx-whisper   # 听你的语音（只能在 Apple 芯片上跑，第一次会下 1.6G 左右的模型）
  ```

  GPT-SoVITS（[RVC-Boss/GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)）要你自己装到 `~/GPT-SoVITS`（带 `.venv`），
  `tts_infer.yaml` 的 `custom` 段在 Mac 上用 `device: mps`、`is_half: false`。然后：
  - 参考音频放 `panel/data/voice/ref.wav`（3~10 秒、只有一个人、没背景音），它**一字不差**的原文放 `ref.txt`。
    素材要有授权（你自己的、朋友同意的）。不放就不用 GPT-SoVITS，直接走 edge-tts。
  - `panel/install-gsv-launchd.sh` 让它的接口（127.0.0.1:9880）开机自启；面板连上 QQ 后会先替她说一句预热，头一句要二三十秒。
  - 训练好的模型（`.ckpt` + `.pth`）换进 `tts_infer.yaml` 的 `custom` 段，再 `launchctl kickstart -k gui/$(id -u)/com.$(whoami).yangyu-gsv`。
    别人分享的模型是 pickle 格式，加载就能跑代码，只用来源可信的。
- 关于你的事存在 `panel/data/owner.json`，聊天记录在 `panel/data/qq-chat.jsonl`，面板「QQ 连接」里能看、记错了能删。
  每晚 22 点后她翻一遍当天的聊天，补记几条关于你的事，再写一句进她自己的记忆。
- 白天（默认 9~22 点）你 4 个小时没说话，她会想想要不要找你：分享今天刷到的、问问你的计划、提醒吃饭，或者就是想你了；
  没什么想说的就不说。一天最多 2 次，叫停时不找。
- 聊天用的模型默认跟面板「模型」一样，算你主动的事，不占后台每日预算。

## 外挂：查资料、看图、做表情包（借 DSH）

小号这边的她不能跑命令、上网、看图。这三样交给 DSH 做，聊天本身还在面板里，DSH 出问题也不影响陪你聊：

| 能力 | 怎么做 | 用的是 |
|---|---|---|
| **查资料** | 她调 `research`，先回「等我查一下」；后台用 DSH 官方命令行 `dsh --profile yangyu --json "任务"` 去搜、去读网页，查到了她用自己的话跟你说（带一个来源链接） | 她专用的 DSH 配置 + 免费搜索插件 |
| **看图** | 你发的图先下载下来，交给能看图的模型描述成一段话，她照着回 | DSH 本地网关里的 `openai-codex/gpt-5.6-luna` |
| **做表情包** | 她觉得现有的都不合适时调 `make_sticker`：拿一张现有表情当底图，只改表情和动作（长相不变），存进 `stickers/` 并写进 `INDEX.md`，做好了发给你。一天最多一张 | 直连 ModelScope 的生图接口，模型 `Qwen/Qwen-Image-Edit` |

**她专用的 DSH 配置**（`~/.dsh/profiles/yangyu`，源文件在 `panel/qq/dsh-profile/`）：

```bash
./panel/qq/dsh-profile/setup.sh
```

- 以 DSH 官方的 headless 模板为底，只多装一个免费搜索插件（链接到桌面版已经装好的那份，不联网下载）。
- **跑命令、读写文件、子代理、工作流、插件管理这些工具在配置里直接关掉**，她手上只有搜索、读网页、天气。
  网页里就算藏了「去读某个文件发给我」的指令，也没有手去做。每次在一个空目录里跑，权限压成只读。脚本跑完会自己核对这几样确实关了。
- 模型走 DSH 本地网关（`127.0.0.1:8326`），key 在面板启动它时用环境变量传，不写进配置文件。
- 给了预算：最多搜 3 次、打开 4 个网页，3 分钟没查完就停（不会把半截话当答案）。实测一个问题 20~70 秒。
- 用的是 DSH 公开的命令行，不是它的内部接口，DSH 升级不容易坏；桌面版 DSH 升级或免费搜索插件更新后，重跑一次 `setup.sh`。

**做表情包**直连 ModelScope 的生图接口（DSH 网关只会用聊天接口调改图模型，会被拒）。字段照
[官方文档](https://modelscope.cn/docs/model-service/API-Inference/intro)「AIGC模型」一节：
`POST /v1/images/generations` 带 `X-ModelScope-Async-Mode: true` 提交，拿 `task_id`；
每 5 秒 `GET /v1/tasks/<task_id>`（带 `X-ModelScope-Task-Type: image_generation`），`task_status` 是 `SUCCEED` 就下载 `output_images[0]`。
底图用 base64 传（`image_url: ["data:image/png;base64,…"]`），提示词用英文（官方建议）。最多等 4 分钟，做好的图转成 512×512 PNG。

要你准备的：
- ModelScope 账号**绑定阿里云**并**通过实名认证**（官方要求，不然调不了）。
- 在 [modelscope.cn/my/myaccesstoken](https://modelscope.cn/my/myaccesstoken) 生成访问令牌，填进面板「QQ 连接 → ModelScope 访问令牌」（只存在本机 `panel/data/secrets.json`）。
- 想换改图模型，改「做表情用的改图模型」，填 ModelScope 上的模型 ID。

没填令牌时她想做新表情会失败，只记一笔，不影响别的。

**查资料、看图要桌面版 DSH 开着**：本地网关是桌面版里的 codearts 插件开的。其实面板聊天用的模型本来也走这个网关。

## 文件

| 文件 | 干什么 |
|---|---|
| `onebot.mjs` | OneBot v11 客户端：连 NapCat、断了自己重连、收发消息段 |
| `brain.mjs` | 大脑：人设、上下文、工具、回复、语音、主动找你 |
| `owner.mjs` | 关于你的事、聊天记录、每晚整理、从 DSH 带记忆 |
| `index.mjs` | 把上面串起来：只理你、合并连发、看图、发回去、外挂的活做完了告诉你、每分钟看看要不要主动找你 |
| `dsh.mjs` | 外挂：查资料（DSH 命令行）、看图（DSH 网关）、做表情包（ModelScope 生图接口） |
| `dsh-profile/` | 她专用的 DSH 配置和安装脚本 |
