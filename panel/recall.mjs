#!/usr/bin/env node
/**
 * 想不起来时翻翻记忆（给 QQ 里的她用）
 *
 * DSH 只把当天的记忆带进对话。号主问起以前的事（「你上次刷到的那个猫猫 UP 叫啥」「前几天跟你吵架那个网友」），
 * 当天记忆里没有，就用这个翻她自己的记忆流（panel/memory.mjs）：
 *
 *   node panel/recall.mjs "猫 UP主"          按相关度 + 多久以前 + 重不重要，挑最该想起的 5 条
 *   node panel/recall.mjs "土星" -n 8        多要几条
 *   node panel/recall.mjs --recent           最近记的 10 条
 *
 * 翻出来的是她自己的经历，不是号主说过的话。
 */
import { recall, ago, memoryView } from './memory.mjs';

const args = process.argv.slice(2);
const n = (() => { const i = args.indexOf('-n'); return i >= 0 ? Math.max(1, Number(args.splice(i, 2)[1]) || 5) : 5; })();
const fmt = (e) => `- ${ago(e.ts)}：${e.text}`;

if (args[0] === '--recent') {
  const { total, recent } = memoryView(10);
  console.log(total ? recent.map(fmt).join('\n') : '还什么都没记');
} else if (!args.length) {
  console.error('用法：node panel/recall.mjs "想起什么" [-n 条数]   或   --recent');
  process.exit(1);
} else {
  const q = args.join(' ');
  // 名字、UP 主名常常就是查询本身，顺手当精确线索
  const top = recall(q, { keys: [`up:${q}`, q], k: n });
  console.log(top.length ? top.map(fmt).join('\n') : `想不起来跟「${q}」有关的事`);
}
