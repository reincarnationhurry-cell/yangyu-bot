# 养鱼日记

记录「蓝色大肥鱼」在 B站刷了什么、看了什么、有什么想法，
晚上把当天记录合成一条 **B站动态** 发出去。

> **硬约束**：日记只记 **她自己刷 B站的见闻**。
> **不要**写与号主的私人对话、工作内容、项目进展、任何私人信息。
> 发到 B站动态是公开的，等于对着所有陌生人说话。

## 为什么是"动态"不是"专栏"

- 动态（`t.bilibili.com`）是 B站轻量短内容，适合日记体，发布成本低。
- 专栏（Opus）适合长文，但需要审核且格式要求高，不适合每天发。

## 目录结构

```
diary/
├── diary.mjs          主脚本
├── README.md          本文档
└── data/
    └── entries.jsonl  所有记录（一行一条 JSON，append-only）
```

## 怎么用（推荐方式）

**直接写。** 想说什么就说什么，写完就发。

```bash
cd diary

# 写今天的日记（正文原样发出，不做任何加工）
node diary.mjs write "今天在B站刷到个讲光年的视频……

我盯着屏幕想了半天，觉得有点浪漫，也有点心慌。"

# 发出去
node diary.mjs publish
```

`write` 的内容就是**最终要发的正文**，代码一个字的模板都不加。

## 也可以先记碎片

刷的时候想到什么随手记，攒着晚上再拼：

```bash
node diary.mjs add --type thought --thought "慢慢来比较快"
node diary.mjs add --type watch   --bvid BV1xx --title "视频标题" --thought "这比我还会糊弄"
node diary.mjs add --type like    --bvid BV1xx --title "视频标题"
node diary.mjs add --type comment --bvid BV1xx --title "视频标题" --text "我发的评论"
node diary.mjs add --type danmaku --bvid BV1xx --title "视频标题" --text "我发的弹幕"
node diary.mjs add --type search  --keyword "关键词" --summary "搜到啥"
```

然后 `compose` 会把你写过的**文字片段**（thought / text）按时间顺序接起来。
注意：只会接文字，**不会**加"今天翻了X""顺手点了N个赞"这类句子——
动作类记录（like/watch）不参与正文拼装，它们只是原始流水，留档用。

## 命令一览

| 命令 | 作用 |
|---|---|
| `write "..."` | 直接写今天的整篇日记（**推荐**） |
| `add --type ...` | 记一个碎片（thought 最有用） |
| `today` | 看今天写了什么 |
| `compose` | 预览要发的正文（不发） |
| `publish` | 发到 B站动态 |
| `publish --dry-run` | 只预览不发布 |
| `publish --force` | 今天已发过还硬要再发 |
| `stats` | 最近 7 天概览 |

## 为什么不用模板了

最初版本是按 `type` 字段拼装的：

```
【养鱼日记 · 日期】
今天在B站翻了翻「X」
看完了：
《Y》
顺手给 N 个视频点了赞
明天继续逛。
```

问题是：**不管刷到什么，出来的都是一个形状**，像填好的表格。
而且"明天继续逛"这种收尾是硬编码的，不是人话。

现在的做法：正文由她自己写，代码只负责发。
没有固定开头、没有固定结尾、没有分类栏目。长短、语气、结构全随内容走。

## 写日记的几条规矩

- **只写B站上看到的事**。这是公开动态，陌生人都能看到。
  **绝对不要**写号主的私事、你们聊了什么、你的工作内容、任何私人信息。
- **像发朋友圈那样写**，不是写周报。可以有碎碎念、可以有情绪、可以只说一句话。
- **一天一条就够**，别刷屏。这号信用分才 70，经不起折腾。
- 内容要干净，别擦边。动态被判违规会扣信用分。
- **没什么可写就不发**，别硬凑。

## 技术细节（踩过的坑）

### 发动态 API
`POST https://api.bilibili.com/x/dynamic/feed/create/dyn?csrf=<bili_jct>`

- **正文必须是 `Content-Type: application/json`**，不是 form-urlencoded。
  用 form 提交会一直返回 `-400 请求错误`，非常迷惑。
- `csrf` 放 **URL 查询参数**，不要塞进 JSON body（塞进去会 `-111 CSRF 校验失败`）。
- payload 结构：

```json
{
  "dyn_req": {
    "content": { "contents": [{ "raw_text": "正文", "type": 1, "biz_id": "" }] },
    "meta": { "app_meta": { "from": "create.dynamic.web", "mobi_app": "web" } },
    "scene": 1
  }
}
```

- `scene: 1` = 纯文本动态。
- 成功返回 `code:0` + `data.dyn_id_str`，动态地址 `https://t.bilibili.com/<dyn_id_str>`。

### 删除动态
`POST https://api.bilibili.com/x/dynamic/feed/operate/remove?csrf=<bili_jct>`
body 是 `{"dyn_id_str":"xxx"}`，同样 JSON + csrf 在 URL。

### cookie
复用 `bilibili-mcp` 扫码登录写的 `../bilibili-mcp/login/cookie.json`，
也可用环境变量 `BILIBILI_COOKIE_FILE` 覆盖。

cookie 失效表现：`-101 未登录` 或 `-111 CSRF 校验失败`。
重新在 DSH 里调 `bilibili_login` + `bilibili_login_check` 扫码即可。

## 注意

- **B站动态是公开的**，发出去所有人可见。别写私人信息。
- 这个号社区信用分只有 70，**别发得太频繁**，一天一条就够。
- 如果动态被判定违规，可能影响信用分 —— 所以内容要干净，别擦边。
