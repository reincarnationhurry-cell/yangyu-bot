#!/usr/bin/env node
/**
 * 号主叫停 CLI（给 QQ 里的她用）
 *
 * 号主说「我打游戏了」「开会呢」「先别吵」，就停下手上的活：不去刷 B站、不看回复、不主动找他。
 * 他说「好了」「打完了」再恢复。没说就照常，别自己琢磨着让路。
 *
 *   node panel/pause.mjs "打游戏"             停到他说好了（最多 24 小时）
 *   node panel/pause.mjs "开会" --hours 2     他说了多久就停多久
 *   node panel/pause.mjs off                  恢复
 *   node panel/pause.mjs                      看现在停没停
 *
 * 直接写 panel/data，面板没开也能用；面板的调度器 30 秒内会看到。
 */
import { readPause, setPause, clearPause } from './store.mjs';

const args = process.argv.slice(2);
const i = args.indexOf('--hours');
const hours = i >= 0 ? Number(args.splice(i, 2)[1]) : undefined;
const hm = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

if (args[0] === 'off') {
  const p = clearPause();
  console.log(p ? '✓ 恢复了，接着过自己的日子' : '本来就没停');
} else if (!args.length && hours === undefined) {
  const p = readPause();
  console.log(p ? `停着呢${p.reason ? `（${p.reason}）` : ''}，${p.untilResume ? '等号主说好了' : '到'} ${hm(p.until)}${p.untilResume ? ' 前会自己恢复' : ''}` : '没停，照常');
} else {
  if (hours !== undefined && !(hours > 0)) { console.error('✗ --hours 要写个正数'); process.exit(1); }
  const p = setPause({ reason: args.join(' '), hours });
  console.log(`✓ 停了，${p.untilResume ? '等他说好了再动（最晚' : '到'} ${hm(p.until)}${p.untilResume ? '）' : ''}。他亲口派的活照做。`);
}
