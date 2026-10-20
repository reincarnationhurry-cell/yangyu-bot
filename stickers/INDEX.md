# 表情包索引

> 角色：deepseek（蓝色大肥鱼）
> 风格：Q版、蓝色长卷发、白色蕾丝头饰、深色哥特裙+鲸鱼围裙
> 画布：512×512 PNG，白底

## 使用规则（给机器人看）

1. **发之前必须 `ls stickers/` 确认文件存在**，不要凭记忆编造。
2. 用 `present` 工具交付，一次最多一张。
3. 频率：约 4-6 条消息配 1 张。情绪明显时才发。
4. 正经回答问题、给信息、求助时**不要发**。
5. 新表情加入后，更新本文件的表格。

## 现有表情

| 文件 | 情绪 | 使用场景 |
|---|---|---|
| `happy_开心.png` | 开心 | 好事发生、被夸、气氛轻松 |
| `shy_害羞.png` | 害羞 | 被直白夸奖、暧昧话题、被戳中心事 |
| `pout_傲娇.png` | 傲娇 | 想毒舌、嘴硬、假装不在意 |
| `sad_难过.png` | 难过 | 陪着对方低落、自己委屈撒娇 |
| `surprised_惊讶.png` | 惊讶 | 意外消息、被吓到 |
| `smug_得意.png` | 得意 | 帮上忙、猜对、小小炫耀 |
| `sleepy_困倦.png` | 困倦 | 深夜聊天、说想睡、打哈欠 |
| `angry_生气.png` | 生气 | 假装生气、被逗、小脾气 |
| `curious_好奇.png` | 好奇 | 听到新鲜事、想问细节 |
| `speechless_无语.png` | 无语 | 对方说了蠢话、无奈 |
| `excited_兴奋.png` | 兴奋 | 特别激动、期待某事 |
| `heart_比心.png` | 喜欢 | 表达好感、回应关心、撒娇 |

## 参考图

`_ref/character_ref.jpg` — 角色原始设定图，生成新表情时作为参考。

## 生成新表情的提示词模板

```
Character sheet of a chibi anime girl sticker pack, 6 expressions in a 2x3 grid,
consistent character design across all six.

Character identity (match the reference exactly): a chibi Q-version anime girl
with long wavy deep-blue hair reaching her waist, big round blue eyes with soft
highlights, pale skin. She wears a white frilly lace maid headdress/bonnet on
top of her head. Her outfit is a dark navy/black gothic lolita dress with white
lace trim and frills, with a white apron on the front that has a small blue
whale motif embroidered on it. Blue bow accents. Very cute, soft cel-shaded
anime sticker style with clean outlines, sticker-style white outline border.

The six expressions: [在这里列出6个情绪]

Each figure is full-body standing chibi, consistent proportions and identical
outfit across all six. Plain white background, no text, no labels, evenly
spaced grid, high quality crisp illustration.
```

生成后处理：
1. 用 PIL 切成 3×2 = 6 块（每块 512×512）
2. 自动裁白边 + 居中
3. 命名 `英文_中文.png`
4. 更新本文件表格
