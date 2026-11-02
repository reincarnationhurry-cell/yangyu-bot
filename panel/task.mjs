#!/usr/bin/env node
/**
 * 任务箱 CLI —— 给机器人用的
 *
 * 面板里点「派活」、或自动养号觉得某个视频值得她亲自评论时，会往
 * panel/data/tasks.jsonl 投任务；机器人用这个脚本读取、认领、标记完成。
 *
 * 用法：
 *   node task.mjs list            看有没有待办
 *   node task.mjs claim <id>      认领（标记为 in_progress）
 *   node task.mjs done <id>       标记完成（可带 --note "做了什么"）
 *   node task.mjs post <id>       贴吧回帖 / 抖音评论：把起草好的那句发出去（可带 --text "改过的"）
 */
import { readTasks, updateTask, nowIso, logAction } from './store.mjs';

const [cmd, id, ...rest] = process.argv.slice(2);
const noteIdx = rest.indexOf('--note');
const note = noteIdx >= 0 ? rest[noteIdx + 1] : '';
const textIdx = rest.indexOf('--text');
const text = textIdx >= 0 ? rest[textIdx + 1] : undefined;

const TYPE_HINT = {
  browse: '随便刷刷B站，看到有意思的点个赞、写两句感想',
  browse_like: '刷B站，挑喜欢的点赞',
  comment: '挑几个视频留两句真实感想',
  diary: '把今天刷到的写进养鱼日记，晚上发动态',
  check: '看看有没有新评论和私信要回',
  tieba_reply: '在贴吧回一句（已经起草好了，用 post 发；不想发就 done 掉）',
  douyin_comment: '在抖音评论一句（已经起草好了，用 post 发；不想发就 done 掉）',
};

switch (cmd) {
  case 'list': {
    const pending = readTasks().filter((t) => t.status === 'pending');
    if (pending.length === 0) { console.log('没有待办任务。'); break; }
    console.log(`有 ${pending.length} 条待办：\n`);
    for (const t of pending.reverse()) {
      console.log(`[${t.id}]`);
      console.log(`  类型: ${t.type}${t.source === 'auto' ? '（自动养号派的）' : ''}`);
      console.log(`  内容: ${t.note || TYPE_HINT[t.type] || '(无说明)'}`);
      if (t.payload?.bvid) console.log(`  视频: ${t.payload.bvid} ${t.payload.title || ''}`);
      if (t.payload?.tid) console.log(`  帖子: ${t.payload.forum || ''}吧 ${t.payload.tid} ${t.payload.title || ''}`);
      if (t.payload?.vid) console.log(`  抖音: ${t.payload.vid} ${t.payload.title || ''}`);
      if (t.payload?.draft) console.log(`  草稿: ${t.payload.draft}\n  → 发：node task.mjs post ${t.id}（想改就加 --text "…"）；不想发：node task.mjs done ${t.id} --note "不发了"`);
      console.log(`  派于: ${new Date(t.ts).toLocaleString('zh-CN')}`);
      console.log('');
    }
    break;
  }
  case 'claim': {
    if (!id) { console.error('用法：node task.mjs claim <id>'); process.exit(1); }
    updateTask(id, { status: 'in_progress', claimedAt: nowIso() });
    console.log(`已认领 ${id}`);
    break;
  }
  case 'done': {
    if (!id) { console.error('用法：node task.mjs done <id> [--note "做了什么"]'); process.exit(1); }
    updateTask(id, { status: 'done', doneAt: nowIso(), resultNote: note });
    logAction({ kind: 'task_done', source: 'bot', target: id, detail: note || '完成了一个任务' });
    console.log(`已完成 ${id}${note ? '：' + note : ''}`);
    break;
  }
  case 'post': {
    // 贴吧 / 抖音这两种活 QQ 里的她没有别的工具能发，所以由这里替她发出去
    if (!id) { console.error('用法：node task.mjs post <id> [--text "改过的"]'); process.exit(1); }
    const t = readTasks().find((x) => x.id === id || x.id.startsWith(id));
    if (!t) { console.error(`找不到任务 ${id}`); process.exit(1); }
    const { TASK_SITE, postDraft } = await import('./webvisit.mjs');
    const site = TASK_SITE[t.type];
    if (!site) { console.error(`${t.type} 不是贴吧 / 抖音的活，用 claim / done`); process.exit(1); }
    try {
      const r = await postDraft(site, t.payload, text ?? t.payload?.draft, 'bot');
      updateTask(t.id, { status: 'done', doneAt: nowIso(), resultNote: `发出去了：${r.text.slice(0, 60)}`, executor: 'bot' });
      console.log(`✓ 发出去了：${r.text}`);
    } catch (e) {
      console.error(`✗ 没发出去：${e.message}`);
      process.exit(1);
    }
    process.exit(0); // 发帖要连浏览器，CDP 连接会吊住事件循环
  }
  default:
    console.log(`任务箱 —— 看面板派给你的活

  node task.mjs list                       看待办
  node task.mjs claim <id>                 认领
  node task.mjs done <id> --note "做了啥"   标记完成
  node task.mjs post <id> [--text "…"]     贴吧 / 抖音的活：把草稿发出去

类型说明：
${Object.entries(TYPE_HINT).map(([k, v]) => `  ${k.padEnd(12)} ${v}`).join('\n')}`);
}
