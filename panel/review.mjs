#!/usr/bin/env node
/**
 * 待审 CLI（给 QQ 里的她用）
 *
 * 面板起草的日记 / 评论 / 回复会进「待审」，也会在 QQ 里提醒号主。
 * 号主在 QQ 里回「可以」「改成……」「算了」，她就用这个把结果落下去：
 *
 *   node panel/review.mjs list                     看有哪些等号主点头的
 *   node panel/review.mjs approve <id>             号主说可以 → 原样发出去
 *   node panel/review.mjs approve <id> --text "…"  号主让改 → 按改好的发
 *   node panel/review.mjs reject <id>              号主说不要 → 丢掉
 *
 * <id> 用 list 里 # 后面那 6 位就行。
 * ⚠️ 只有号主在聊天里明确同意了才能 approve；没问过就发 = 越权。
 */
import { readReview } from './store.mjs';
import { approveReview, rejectReview } from './autopilot.mjs';
import { shortId, wasReminded } from './notify.mjs';

const [cmd, id, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const KIND = { diary: '📔 日记（公开动态）', comment: '💬 评论', reply: '↩️ 回复' };

function fail(msg) { console.error('✗ ' + msg); process.exit(1); }

try {
  if (cmd === 'list' || !cmd) {
    const list = readReview().filter((x) => x.status === 'pending');
    if (!list.length) { console.log('没有等号主审的东西'); process.exit(0); }
    for (const r of list) {
      const p = r.payload || {};
      const where = r.kind === 'reply' ? `回 @${p.user}（TA 说：${(p.said || '').slice(0, 40)}）` : r.kind === 'comment' ? `《${p.title || p.bvid}》` : p.date || '';
      const told = wasReminded(r.id) ? '  （已在 QQ 提醒过号主）' : '  （还没提醒过号主）';
      console.log(`#${shortId(r.id)}  ${KIND[r.kind] || r.kind}  ${where}${told}\n    ${r.text.replace(/\n/g, '\n    ')}\n`);
    }
  } else if (cmd === 'approve') {
    if (!id) fail('要给待审编号（list 里 # 后面那 6 位）');
    const r = await approveReview(id, flag('text'), 'bot');
    console.log(`✓ 发出去了（${KIND[r.kind] || r.kind}）${r.url ? ' ' + r.url : ''}`);
  } else if (cmd === 'reject') {
    if (!id) fail('要给待审编号');
    rejectReview(id, 'bot');
    console.log('✓ 丢掉了');
  } else {
    console.log('用法：node panel/review.mjs list | approve <id> [--text "改后的"] | reject <id>');
  }
} catch (e) {
  fail(e.message);
}
