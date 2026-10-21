#!/usr/bin/env node
/**
 * 交给后台 CLI（给 QQ 里的她用）
 *
 * 号主让她去 B站 干一件要花时间的活，她别自己一步步调工具（每一步都要等模型，号主干等好几分钟），
 * 而是先回一句「好，我去」，用这个把活交给面板后台，回合马上结束。
 * 后台做完会自己在 QQ 里跟号主汇报（panel/notify.mjs → reportTask）。
 *
 *   node panel/bg.mjs "号主的原话"            交给后台（不认识的活按大白话解析成计划）
 *   node panel/bg.mjs "…" --type check        看新评论/私信，起草回复进待审
 *   node panel/bg.mjs "…" --type diary        起草今天的日记进待审
 *   node panel/bg.mjs list                    后台在做的、最近做完的
 *
 * 面板没开（launchd 没跑）会直接报错退出 —— 那就自己做，或者跟号主说一声。
 */
import { readTasks } from './store.mjs';

const PORT = Number(process.env.PANEL_PORT || 8899);
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const STATUS = { pending: '排队', in_progress: '在做', done: '做完了', failed: '没做成', cancelled: '取消了' };

function fail(msg) { console.error('✗ ' + msg); process.exit(1); }

if (args[0] === 'list') {
  const mine = readTasks().filter((t) => t.report === 'qq').slice(0, 8);
  if (!mine.length) { console.log('后台没有你交过去的活'); process.exit(0); }
  for (const t of mine) {
    const when = new Date(t.ts).toLocaleString('zh-CN');
    console.log(`[${STATUS[t.status] || t.status}] ${t.note}（${when}）${t.resultNote ? '\n    → ' + t.resultNote : ''}`);
  }
  process.exit(0);
}

const type = flag('type');
const note = args.join(' ').trim();
if (!note) fail('用法：node panel/bg.mjs "号主的原话" [--type check|diary] | list');
if (type && !['check', 'diary'].includes(type)) fail(`不认识的 --type ${type}（只有 check / diary，其他活不用写 type）`);

let res;
try {
  res = await fetch(`http://127.0.0.1:${PORT}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: type || 'custom', note, executor: 'panel', report: 'qq' }),
    signal: AbortSignal.timeout(5000),
  });
} catch {
  fail('后台（养鱼面板）没在跑，交不出去：自己做，或者跟号主说一声面板没开');
}
const j = await res.json().catch(() => ({}));
if (!res.ok) fail(j.error || `面板报错 HTTP ${res.status}`);
console.log(`✓ 交给后台了（#${j.task.id.slice(0, 6)}），做完会自己在 QQ 里跟号主说。这一轮你别再调工具了，直接结束。`);
