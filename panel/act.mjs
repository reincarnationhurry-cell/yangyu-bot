#!/usr/bin/env node
/**
 * 给 QQ 机器人用的 B站动作 CLI
 *
 * 和 MCP 工具的区别：
 *  - watch 会用播放心跳真的「看」，能留下观看记录、拿每日观看经验（MCP 的 video_info 不会）
 *  - 所有动作都记进面板的「活动记录」（来源 = bot）
 *  - 每日上限和投币锁与自动养号共用
 *
 * 用法：
 *   node act.mjs watch BV1xx [--sec 120]     看视频（不给 --sec 就按真人习惯随机看一段）
 *   node act.mjs like BV1xx                  点赞
 *   node act.mjs share BV1xx                 分享（每日 +5 经验）
 *   node act.mjs comment BV1xx "评论内容"     发评论
 *   node act.mjs exp                         看今天的经验任务完成情况
 */
import * as bili from './bili.mjs';
import { logAction, todayCounts, readConfig } from './store.mjs';

const SRC = 'bot';
const [cmd, bvid, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const cfg = readConfig();

function fail(msg) { console.error('✗ ' + msg); process.exit(1); }
function needBvid() { if (!bvid || !/^BV/i.test(bvid)) fail('要给 BV 号'); }

try {
  switch (cmd) {
    case 'watch': {
      needBvid();
      const info = await bili.browseVideo(bvid);
      const dur = info.duration || 60;
      const sec = Number(flag('sec')) ||
        Math.round(Math.min(dur * (0.45 + Math.random() * 0.5), cfg.session.maxWatchSec, dur));
      console.log(`▶ 开始看《${info.title}》，计划 ${sec} 秒（视频 ${dur} 秒）…`);
      const w = await bili.watchVideo(bvid, { seconds: sec });
      logAction({ kind: 'watch', source: SRC, target: bvid, title: info.title,
        detail: `看了《${info.title}》${w.played} / ${dur} 秒`, meta: { played: w.played, duration: dur, owner: info.owner } });
      console.log(`✓ 看完了 ${w.played} 秒，已留下观看记录`);
      console.log(`  UP：${info.owner} · 播放 ${info.stat.view} · 点赞 ${info.stat.like}`);
      console.log(`  热评：\n${info.comments.slice(0, 5).map((c) => '   - ' + c.text.slice(0, 60)).join('\n')}`);
      break;
    }
    case 'like': {
      needBvid();
      if ((todayCounts().like || 0) >= cfg.like.dailyMax) fail(`今天已经点了 ${cfg.like.dailyMax} 个赞，歇歇吧`);
      await bili.likeVideo(bvid, true);
      logAction({ kind: 'like', source: SRC, target: bvid, detail: '点赞' });
      console.log('✓ 已点赞');
      break;
    }
    case 'share': {
      needBvid();
      await bili.shareVideo(bvid);
      logAction({ kind: 'share', source: SRC, target: bvid, detail: '分享' });
      console.log('✓ 已分享');
      break;
    }
    case 'comment': {
      needBvid();
      const text = rest.filter((x) => !x.startsWith('--')).join(' ').trim();
      if (!text) fail('评论内容呢？');
      if ((todayCounts().comment || 0) >= cfg.comment.dailyMax + 2) fail('今天评论够多了，明天再说');
      const r = await bili.postComment({ bvid, message: text });
      logAction({ kind: 'comment', source: SRC, target: bvid, detail: text });
      console.log(`✓ 已发评论（rpid ${r.rpid}）`);
      break;
    }
    case 'exp': {
      const [a, e] = await Promise.all([bili.getAccountStatus(), bili.getExpStatus()]);
      console.log(`Lv${a.level}  经验 ${a.exp}/${a.expNext}  硬币 ${a.coins}`);
      console.log(`今日：登录${e.login ? '✓' : '✗'} 观看${e.watch ? '✓' : '✗'} 分享${e.share ? '✓' : '✗'} 投币经验 ${e.coinsExp}/50`);
      if (bili.coinLock()) console.log('投币：已上锁（失败过），别投');
      break;
    }
    default:
      console.log(`B站动作 CLI（会留下真实观看记录，并记进面板活动记录）

  node act.mjs watch BV1xx [--sec 120]
  node act.mjs like BV1xx
  node act.mjs share BV1xx
  node act.mjs comment BV1xx "评论内容"
  node act.mjs exp`);
  }
} catch (e) {
  logAction({ kind: cmd || 'error', source: SRC, ok: false, target: bvid, error: e.message, detail: '失败' });
  fail(e.message);
}
