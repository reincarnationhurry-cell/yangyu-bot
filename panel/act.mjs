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
 *   node act.mjs find 关键词                 先搜，拿到真实的 BV 号
 *   node act.mjs watch BV1xx [--sec 120]     看视频（默认后台看，马上返回；--fg 前台等看完）
 *   node act.mjs like BV1xx                  点赞
 *   node act.mjs share BV1xx                 分享（每日 +5 经验）
 *   node act.mjs comment BV1xx "评论内容"     发评论
 *   node act.mjs exp                         看今天的经验任务完成情况
 */
import * as bili from './bili.mjs';
import { logAction, todayCounts, readConfig, withBlock } from './store.mjs';

const SRC = 'bot';
const [cmd, bvid, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const cfg = readConfig();

function fail(msg) { console.error('✗ ' + msg); process.exit(1); }
function needBvid() { if (!bvid || !/^BV/i.test(bvid)) fail('要给 BV 号'); }

try {
  switch (cmd) {
    case 'find': {
      // 先搜再看：BV 号必须来自真实搜索结果，别凭记忆编
      const kw = [bvid, ...rest].filter((x) => x && !x.startsWith('--')).join(' ');
      if (!kw) fail('要给关键词：node act.mjs find 关键词');
      const list = await bili.searchVideo(kw, flag('new') !== undefined ? 'pubdate' : 'totalrank');
      if (!list.length) fail(`搜「${kw}」什么都没有`);
      for (const v of list.slice(0, 8)) console.log(`${v.bvid}  ${v.durationSec ? Math.round(v.durationSec / 60) + '分钟' : ''}  《${v.title}》 · ${v.owner}`);
      break;
    }
    case 'watch': {
      needBvid();
      const info = await bili.browseVideo(bvid);
      const dur = info.duration || 60;
      const sec = Number(flag('sec')) ||
        Math.round(Math.min(dur * (0.45 + Math.random() * 0.5), cfg.session.maxWatchSec, dur));
      // 默认放到后台去看：心跳要真的等那么久（几分钟），前台等着会把整轮 QQ 回复拖住，
      // 号主那边就是「半天不回」。后台子进程看完会自己记进活动记录。
      if (!process.env.ACT_WATCH_CHILD && !rest.includes('--fg')) {
        const { spawn } = await import('node:child_process');
        const child = spawn(process.execPath, [process.argv[1], 'watch', bvid, '--sec', String(sec), '--fg'], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, ACT_WATCH_CHILD: '1' },
        });
        child.unref();
        console.log(`▶ 在后台开始看《${info.title}》，计划 ${sec} 秒（视频 ${dur} 秒），看完会自己记进活动记录`);
        console.log(`  UP：${info.owner} · 播放 ${info.stat.view} · 点赞 ${info.stat.like}`);
        console.log(`  简介：${String(info.desc || '').slice(0, 80)}`);
        console.log(`  热评：\n${info.comments.slice(0, 5).map((c) => '   - ' + c.text.slice(0, 60)).join('\n')}`);
        console.log('  （不用等它看完，可以直接回号主）');
        break;
      }
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
      await withBlock('like', () => bili.likeVideo(bvid, true));
      logAction({ kind: 'like', source: SRC, target: bvid, detail: '点赞' });
      console.log('✓ 已点赞');
      break;
    }
    case 'share': {
      needBvid();
      await withBlock('share', () => bili.shareVideo(bvid));
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
  // -404「啥都木有」= 这个 BV 号不存在：多半是凭记忆编的，或者视频被删了
  if (e.code === -404 || /啥都木有/.test(e.message)) {
    fail(`${bvid} 这个视频不存在（被删了，或者 BV 号是记错/编的）。先 node panel/act.mjs find 关键词 搜一个真实的再看`);
  }
  fail(e.message);
}
