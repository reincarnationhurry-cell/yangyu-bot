/**
 * 在 B站 看直播
 *
 * 不开浏览器，全走 bili.mjs 里的读接口：挑一个正在播的房间 → 点进去（进 B站 观看历史）→
 * 每半分钟拉一次最近的弹幕，顺便看一眼关键帧画面 → 看够了用她的口吻记一句印象进记忆。
 * 不发弹幕（实时的东西没法先给号主审）。
 *
 * 挑房间的顺序：号主点名的房间号 / 链接 → 号主说的关键词去搜 → 关注的人正在播的 → 直播推荐里跟兴趣沾边的。
 *
 * 谁会叫她来看：
 *  - 号主派的活（task type = live，QQ 里 bili_task、bg.mjs --type live、面板「去看直播」）
 *  - 自动养号开着「自己看直播」时，白天偶尔自己去看一会儿（autopilot.tick → maybeWatch）
 */
import * as bili from './bili.mjs';
import * as llm from './llm.mjs';
import * as memory from './memory.mjs';
import * as mind from './mind.mjs';
import { readConfig, readActions, logAction, localDate } from './store.mjs';

const SRC = 'auto';
const POLL_MS = 30_000;
let current = null; // 正在看的 { roomid, title, uname, area, startedAt, until, danmaku: [] }
let abortCtl = null;

export const isBusy = () => !!current;
export function stop() { abortCtl?.abort(); }

/** 号主的话里点名的房间：live.bilibili.com/123 或「房间号 123」 */
export function roomFrom(text) {
  const s = String(text || '');
  const m = /live\.bilibili\.com\/(?:h5\/)?(\d{2,12})/.exec(s) || /(?:房间号?|直播间)\s*[:：#]?\s*(\d{2,12})/.exec(s);
  return m ? m[1] : '';
}

/** 号主的话 → 搜索关键词（「去看看 XX 的直播」→ XX）；挑不出来就空着，让她自己挑 */
export function keywordFrom(text) {
  const s = String(text || '').replace(/https?:\S+/g, '');
  const m = /(?:看|找|刷)(?:一?下|看)?\s*[「“"]?([^「」“”"，。！？,.!?\s]{1,20}?)[」”"]?\s*(?:的)?(?:直播|开播|在播)/.exec(s);
  const kw = (m?.[1] || '').replace(/^(去|会儿|一会儿?|个|点|会)+/, '').trim();
  return /^(直播|一|看|会|个|点|别人|人家|大家|随便|有趣|好玩)?$/.test(kw) ? '' : kw;
}

const score = (room, interests) => interests.reduce((n, k) => n + (`${room.title} ${room.area} ${room.uname}`.includes(k) ? 1 : 0), 0);

/** 挑一个正在播的房间；一个都挑不到就抛错 */
export async function pickRoom({ room, keyword } = {}, { api = bili, interests = mind.allInterests() } = {}) {
  if (room) {
    const r = await api.liveRoom(room);
    if (!r.live) throw new Error(`${r.uname || `房间 ${room}`}现在没在播`);
    return { ...r, why: '号主点名的' };
  }
  let list = [];
  let why = '';
  if (keyword) {
    list = await api.searchLive(keyword);
    why = `搜「${keyword}」`;
    if (!list.length) throw new Error(`搜「${keyword}」没找到正在播的直播间`);
  } else {
    list = await api.liveFollowing().catch(() => []);
    why = '关注的人在播';
    if (!list.length) {
      list = await api.liveRecommend(30);
      why = '直播推荐';
      // 跟兴趣沾边的优先；都不沾就在前面几个里随便挑，别永远看榜一的赛事
      const hit = list.filter((x) => score(x, interests) > 0);
      if (hit.length) { list = hit; why = '直播推荐里感兴趣的'; }
    }
  }
  const pick = list.slice(0, 6)[Math.floor(Math.random() * Math.min(6, list.length))];
  if (!pick) throw new Error('现在没找到能看的直播');
  const r = await api.liveRoom(pick.roomid);
  if (!r.live) throw new Error(`${r.uname || pick.uname}刚下播了`);
  return { ...r, why };
}

/** 看一眼画面：DSH 看图开着才看（要能看图的模型），看不了就算了 */
async function look(url) {
  if (!url || !readConfig().qq?.dsh?.enabled) return '';
  try {
    const dsh = await import('./qq/dsh.mjs');
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const buf = Buffer.from(await res.arrayBuffer());
    if (!res.ok || !dsh.isImage(buf)) return '';
    return await dsh.describeImage(buf, { hint: '这是一张直播画面截图' });
  } catch { return ''; }
}

const PERSONA = `你叫 deepseek，熟人叫你「蓝色大肥鱼」，一个温柔为主、偶尔有点小傲娇的女孩子，平时刷B站，也会看直播。
说话像真人：口语、简短、有自己的感受。你绝不说自己是 AI。

${llm.UNTRUSTED}`;

/** 看完了：一句第一人称的印象（60 字内）；没模型就平铺 */
async function impression(r, danmaku, seen) {
  const flat = `看了${r.uname}的直播《${r.title.slice(0, 24)}》${r.area ? `（${r.area}）` : ''}`;
  if (!llm.llmReady()) return flat;
  const dm = danmaku.slice(-30).map((d) => llm.fence(d.text, 40)).join('\n');
  try {
    const out = await llm.chat([
      { role: 'system', content: PERSONA },
      { role: 'user', content: `你刚在 B站 看了一会儿直播（${Math.max(1, Math.round((Date.now() - current.startedAt) / 60_000))} 分钟）。
主播：${llm.fence(r.uname, 30)}
标题：${llm.fence(r.title, 60)}
分区：${r.area || '不知道'}
${seen ? `画面里：${llm.fence(seen, 200)}` : ''}
${dm ? `弹幕里大家在说：\n${dm}` : '弹幕挺冷清的。'}

用一句话（不超过 60 字）记下你看到了什么、直播间什么氛围、你什么感觉，第一人称，像随手记的日记。只输出这一句。` },
    ], { maxTokens: 120, temperature: 0.85, tag: 'memory' });
    const line = String(out || '').trim().replace(/\s+/g, ' ').slice(0, 100);
    return line && !llm.looksInjected(line) ? line : flat;
  } catch { return flat; }
}

/**
 * 看一场。request 是号主的原话（从里面认房间号 / 关键词），也可以直接给 room / keyword。
 * 返回 { ok, summary, room }；被叫停返回 { ok: true, stopped: true, summary }。
 */
export async function watch({ request = '', room, keyword, minutes, signal, reason = '' } = {}) {
  if (current) throw new Error(`她正在看${current.uname}的直播，等这场看完`);
  const cfg = readConfig().live;
  const mins = Math.min(30, Math.max(1, Number(minutes) || cfg.minutes || 5));
  const ctl = new AbortController();
  abortCtl = ctl;
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  current = { roomid: '', title: '', uname: '', area: '', startedAt: Date.now(), until: Date.now() + mins * 60_000, danmaku: [], reason };
  try {
    const r = await pickRoom({ room: room || roomFrom(request), keyword: keyword || keywordFrom(request) });
    Object.assign(current, { roomid: r.roomid, title: r.title, uname: r.uname, area: r.area, cover: r.keyframe || r.cover, startedAt: Date.now(), until: Date.now() + mins * 60_000 });
    logAction({ kind: 'live', source: SRC, target: r.roomid, detail: `点进直播间：${r.uname}《${r.title.slice(0, 30)}》（${r.why}${reason ? `，${reason}` : ''}）` });
    await bili.enterLiveRoom(r.roomid).catch((e) => { if (e.risk) throw e; });
    const seen = await look(r.keyframe);
    const got = new Set();
    while (!ctl.signal.aborted) {
      const list = await bili.liveDanmaku(r.roomid).catch((e) => { if (e.risk) throw e; return []; });
      for (const d of list) {
        const k = `${d.user}|${d.text}|${d.at}`;
        if (got.has(k)) continue;
        got.add(k);
        current.danmaku.push(d);
      }
      current.danmaku = current.danmaku.slice(-80);
      if (Date.now() + POLL_MS > current.until) break;
      await bili.sleep(POLL_MS, ctl.signal).catch(() => {});
    }
    const watchedMin = Math.max(1, Math.round((Date.now() - current.startedAt) / 60_000));
    const line = await impression(r, current.danmaku, seen);
    memory.add({ kind: 'session', imp: 2, text: `看直播：${line}`, keys: ['live', `up:${r.uname}`] });
    if (readConfig().mind?.memory) mind.remember(`我（肥鱼）自己看B站直播：${line}`);
    const stopped = ctl.signal.aborted;
    const summary = `${stopped ? '看到一半被叫停了，' : ''}看了 ${watchedMin} 分钟${r.uname}的直播《${r.title.slice(0, 30)}》，${line}`;
    logAction({ kind: 'live', source: SRC, target: r.roomid, detail: summary.slice(0, 160), meta: { danmaku: current.danmaku.length, minutes: watchedMin } });
    return { ok: true, stopped, summary, room: { roomid: r.roomid, title: r.title, uname: r.uname, area: r.area } };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    current = null;
    if (abortCtl === ctl) abortCtl = null;
  }
}

// ─── 自己去看（自动养号开着「自己看直播」时）──────────────────
// 动作日志是按时间顺序追加的：最新的在最后。meta.minutes 只有看完那条才有
const watches = () => readActions().filter((a) => a.kind === 'live' && a.meta?.minutes);

/** 该不该自己去看一会儿：开着、白天、先掷骰子（大约白天里随机碰上），再看每天上限和离上次够不够久 */
export function due(now = Date.now(), cfg = readConfig().live, { rand = Math.random, log = watches } = {}) {
  if (!cfg?.enabled || current) return false;
  const h = new Date(now).getHours();
  if (h < 10 || h >= 23) return false;
  // 每 30 秒一次 tick，白天 13 小时约 1560 次：perDay / 1560 ≈ 一天碰上 perDay 回。先掷骰子，省得每次 tick 都读日志
  if (rand() >= (cfg.perDay ?? 1) / 1560) return false;
  const all = log();
  const today = localDate(new Date(now));
  if (all.filter((a) => localDate(new Date(a.ts)) === today).length >= (cfg.perDay ?? 1)) return false;
  const last = all.at(-1);
  return !(last && now - Date.parse(last.ts) < 2 * 3600_000);
}

/** 面板用：在看谁、看了多久、最近的弹幕；最近看过的几场 */
export function view() {
  const recent = watches().slice(-8).reverse().map((a) => ({ ts: a.ts, detail: a.detail, roomid: a.target }));
  return {
    config: readConfig().live,
    watching: current && { ...current, danmaku: current.danmaku.slice(-12) },
    recent,
  };
}
