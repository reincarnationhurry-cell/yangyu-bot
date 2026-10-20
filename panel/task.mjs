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
 */
import { readTasks, updateTask, nowIso, logAction } from './store.mjs';

const [cmd, id, ...rest] = process.argv.slice(2);
const noteIdx = rest.indexOf('--note');
const note = noteIdx >= 0 ? rest[noteIdx + 1] : '';

const TYPE_HINT = {
  browse: '随便刷刷B站，看到有意思的点个赞、写两句感想',
  browse_like: '刷B站，挑喜欢的点赞',
  comment: '挑几个视频留两句真实感想',
  diary: '把今天刷到的写进养鱼日记，晚上发动态',
  check: '看看有没有新评论和私信要回',
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
  default:
    console.log(`任务箱 —— 看面板派给你的活

  node task.mjs list                       看待办
  node task.mjs claim <id>                 认领
  node task.mjs done <id> --note "做了啥"   标记完成

类型说明：
${Object.entries(TYPE_HINT).map(([k, v]) => `  ${k.padEnd(12)} ${v}`).join('\n')}`);
}
