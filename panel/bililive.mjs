/**
 * 在 B站 看直播
 *
 * 不开浏览器，全走 bili.mjs 里的读接口：挑一个正在播的房间 → 点进去（进 B站 观看历史）→
 * 每半分钟拉一次最近的弹幕，顺便看一眼关键帧画面 → 看够了用她的口吻记一句印象进记忆。
 * 平时不发弹幕（实时的东西没法先给号主审）。
 *
 * 陪号主看（stay）：号主说「陪我看 XX 的直播」，她就一直待在直播间，直到号主叫她出来（leave）、主播下播、
 * 或者待满 live.stayMaxHours。这期间每两三分钟「想一下」：看看新弹幕（隔一阵再看一眼画面），
 * 决定要不要发条弹幕（号主允许了才发，有每小时上限）、要不要在聊天里跟号主说一句（最多 15 分钟一次）。
 * 号主在聊天里跟她说话时，她知道直播间里正在发生什么（companionText）。
 *
 * 挑房间的顺序：号主点名的房间号 / 链接 → 号主说的关键词去搜 → 关注的人正在播的 → 直播推荐里跟兴趣沾边的。
 *
 * 谁会叫她来看：
 *  - 号主派的活（task type = live，QQ 里 bili_task、bg.mjs --type live、面板「去看直播」）；payload.stay = 陪看
 *  - 自动养号开着「自己看直播」时，白天偶尔自己去看一会儿（autopilot.tick → maybeWatch）
 */
import * as bili from './bili.mjs';
import * as llm from './llm.mjs';
import * as memory from './memory.mjs';
import * as mind from './mind.mjs';
import { readConfig, readActions, logAction, localDate, who, readPause, blockedFor, withBlock } from './store.mjs';

const SRC = 'auto';
// 节奏（毫秒）。测试里会改小，别处别动
export const T = {
  poll: 30_000, // 多久拉一次弹幕
  think: 150_000, // 陪看时多久想一下
  look: 10 * 60_000, // 陪看时多久重新看一眼画面
  recheck: 5 * 60_000, // 多久确认一次还在播
  sayGap: 15 * 60_000, // 跟号主说话至少隔多久
  dmGap: 3 * 60_000, // 两条弹幕至少隔多久
};
let current = null; // 正在看的 { roomid, title, uname, area, startedAt, until, danmaku: [], stay, dmOn, mine: [], said: [] }
let abortCtl = null;
let running = null; // 正在看的那一场（watch 的 promise），leave 等它收尾

export const isBusy = () => !!current;
export const isStaying = () => !!current?.stay;
export function stop() { abortCtl?.abort(); }

/** 叫她出来：停下并等她看完收尾（记印象），返回那一场的结果；没在看返回 null */
export async function leave() {
  if (!current) return null;
  const p = running;
  current.byOwner = true; // 号主自己叫的：结果他当场就知道，后台不用再汇报一遍
  stop();
  return p ? p.catch(() => null) : null;
}

/** 陪看中改主意：开 / 关弹幕 */
export function setDanmaku(on) {
  if (!current) return false;
  current.dmOn = !!on;
  return true;
}

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

const PERSONA = () => `你叫 ${who().name}，熟人叫你「${who().nick}」，一个${who().vibe}，平时刷B站，也会看直播。
说话像真人：口语、简短、有自己的感受。你绝不说自己是 AI。

${llm.UNTRUSTED}`;

/** 看完了：一句第一人称的印象（60 字内）；没模型就平铺 */
async function impression(r, danmaku, seen) {
  const flat = `看了${r.uname}的直播《${r.title.slice(0, 24)}》${r.area ? `（${r.area}）` : ''}`;
  if (!llm.llmReady()) return flat;
  const dm = danmaku.slice(-30).map((d) => llm.fence(d.text, 40)).join('\n');
  try {
    const out = await llm.chat([
      { role: 'system', content: PERSONA() },
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
export function watch(opts = {}) {
  if (current) return Promise.reject(new Error(`她正在看${current.uname || '直播'}，${current.stay ? '先叫她出来' : '等这场看完'}`));
  running = watchOnce(opts);
  return running.finally(() => { running = null; });
}

async function watchOnce({ request = '', room, keyword, minutes, signal, reason = '', stay = false, danmaku } = {}) {
  const cfg = readConfig().live;
  const mins = stay ? Math.max(0.5, Number(cfg.stayMaxHours) || 4) * 60 : Math.min(30, Math.max(1, Number(minutes) || cfg.minutes || 5));
  const ctl = new AbortController();
  abortCtl = ctl;
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  current = {
    roomid: '', title: '', uname: '', area: '', startedAt: Date.now(), until: Date.now() + mins * 60_000, danmaku: [], reason,
    stay: !!stay, dmOn: !!(stay && (danmaku ?? cfg.danmaku)), mine: [], said: [], seen: '', ended: false,
  };
  try {
    const r = await pickRoom({ room: room || roomFrom(request), keyword: keyword || keywordFrom(request) });
    Object.assign(current, { roomid: r.roomid, title: r.title, uname: r.uname, area: r.area, cover: r.keyframe || r.cover, startedAt: Date.now(), until: Date.now() + mins * 60_000 });
    logAction({ kind: 'live', source: SRC, target: r.roomid, detail: `点进直播间：${r.uname}《${r.title.slice(0, 30)}》（${r.why}${reason ? `，${reason}` : ''}）` });
    await bili.enterLiveRoom(r.roomid).catch((e) => { if (e.risk) throw e; });
    let seen = await look(r.keyframe);
    current.seen = seen;
    if (current.stay) {
      tell(`进来啦，${r.uname}在播《${r.title.slice(0, 30)}》${seen ? `，${seen.slice(0, 40)}` : ''}。你要我出来就说一声～`, 'live');
    }
    const got = new Set();
    let lastThink = Date.now();
    let lastLook = Date.now();
    let lastCheck = Date.now();
    let fresh = [];
    while (!ctl.signal.aborted) {
      const list = await bili.liveDanmaku(r.roomid).catch((e) => { if (e.risk) throw e; return []; });
      for (const d of list) {
        const k = `${d.user}|${d.text}|${d.at}`;
        if (got.has(k)) continue;
        got.add(k);
        current.danmaku.push(d);
        fresh.push(d);
      }
      current.danmaku = current.danmaku.slice(-80);
      if (current.stay) {
        const now = Date.now();
        if (readPause()) { ctl.abort(); break; } // 号主叫停了：她也从直播间出来
        if (now - lastCheck > T.recheck) {
          lastCheck = now;
          const info = await bili.liveRoom(r.roomid).catch(() => null);
          if (info && !info.live) { current.ended = true; break; }
          if (info?.title) current.title = info.title;
          if (now - lastLook > T.look && info?.keyframe) { lastLook = now; seen = (await look(info.keyframe)) || seen; current.seen = seen; }
        }
        if (now - lastThink > T.think) {
          lastThink = now;
          await think(r, fresh.slice(-25)).catch((e) => { if (e.risk) throw e; console.error('[live] think', e.message); });
          fresh = [];
        }
      }
      if (Date.now() + T.poll > current.until) break;
      await bili.sleep(T.poll, ctl.signal).catch(() => {});
    }
    const watchedMin = Math.max(1, Math.round((Date.now() - current.startedAt) / 60_000));
    const line = await impression(r, current.danmaku, seen);
    memory.add({ kind: 'session', imp: 2, text: `看直播：${line}`, keys: ['live', `up:${r.uname}`] });
    if (readConfig().mind?.memory) mind.remember(`${llm.selfTag()}自己看B站直播：${line}`);
    const stopped = ctl.signal.aborted;
    const how = current.stay
      ? (current.ended ? '主播下播了，' : stopped ? '' : '待太久了先出来了，')
      : (stopped ? '看到一半被叫停了，' : '');
    const dm = current.mine.length ? `，发了 ${current.mine.length} 条弹幕` : '';
    const summary = `${how}${current.stay ? '陪你' : ''}看了 ${watchedMin} 分钟${r.uname}的直播《${r.title.slice(0, 30)}》${dm}，${line}`;
    logAction({ kind: 'live', source: SRC, target: r.roomid, detail: summary.slice(0, 160), meta: { danmaku: current.danmaku.length, minutes: watchedMin, mine: current.mine.length, stay: current.stay } });
    return { ok: true, stopped, byOwner: !!current.byOwner, summary, room: { roomid: r.roomid, title: r.title, uname: r.uname, area: r.area } };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    current = null;
    if (abortCtl === ctl) abortCtl = null;
  }
}

// ─── 陪看：想一下、发弹幕、跟号主说一句 ──────────────────────────
/** 跟号主说一句（QQ / Telegram 连着就发那边，不然留在面板聊天框）。不阻塞看直播 */
function tell(text, kind = 'live') {
  if (!readConfig().live.chat && kind === 'live') return;
  import('./qq/index.mjs').then((qq) => qq.tellOwner(text, kind)).catch((e) => console.error('[live] tell', e.message));
}

const DM_RULES = `发弹幕的规矩：
- 一条不超过 20 个字，像直播间里普通观众随口说的，接住当下的梗或者主播刚说的事；别复读别人的弹幕，别刷屏。
- 不带链接、联系方式、群号，不说「关注我」「互关」，不引战、不攻击主播和观众，不涉及政治、色情、违法。
- 不提号主，不提自己是谁、在陪谁看。`;

/** 每两三分钟想一下：要不要发弹幕、要不要跟号主说一句。返回 { dm, say }（都可能是空的） */
async function think(r, fresh) {
  const cfg = readConfig().live;
  const now = Date.now();
  const lastDm = current.mine.at(-1)?.at || 0;
  const hourDm = current.mine.filter((d) => now - d.at < 3600_000).length;
  const canDm = current.dmOn && now - lastDm > T.dmGap && hourDm < (cfg.danmakuPerHour ?? 6) && !blockedFor('live_dm');
  const lastSay = current.said.at(-1)?.at || current.startedAt;
  const canSay = cfg.chat && now - lastSay > T.sayGap;
  if ((!canDm && !canSay) || !llm.llmReady()) return {};
  const dm = fresh.map((d) => llm.fence(d.text, 40)).join('\n');
  const chat = (await import('./qq/owner.mjs')).recentChat(6).filter((e) => Date.parse(e.ts) > current.startedAt)
    .map((e) => `${e.from === 'owner' ? '他' : '你'}：${llm.fence(e.text, 60)}`).join('\n');
  const out = llm.looseJson(await llm.chat([
    { role: 'system', content: `${PERSONA()}\n\n${DM_RULES}` },
    { role: 'user', content: `你正陪号主（你最熟的那个人）一起看 B站 直播，已经看了 ${Math.round((now - current.startedAt) / 60_000)} 分钟。
主播：${llm.fence(r.uname, 30)}　标题：${llm.fence(current.title || r.title, 60)}　分区：${r.area || '不知道'}
${current.seen ? `画面里：${llm.fence(current.seen, 200)}` : ''}
${dm ? `这两分钟的弹幕：\n${dm}` : '这两分钟弹幕挺安静的。'}
${current.mine.length ? `你之前发过的弹幕：${current.mine.slice(-3).map((d) => d.text).join(' / ')}` : ''}
${chat ? `你们这期间在聊天里说的：\n${chat}` : ''}

${canDm ? '想发弹幕就写在 dm 里（真有想说的才发，大多数时候不发）；' : ''}${canSay ? '有特别好玩、想跟号主分享的，写在 say 里，像微信里跟他说的一句话（大多数时候不说）；' : ''}
只输出 JSON：{"dm":"${canDm ? '弹幕或空' : ''}","say":"${canSay ? '想跟他说的或空' : ''}"}` },
  ], { maxTokens: 160, temperature: 0.9, tag: 'live', essential: true }));
  const res = {};
  const d = String(out?.dm || '').replace(/\s+/g, ' ').trim().slice(0, 20);
  if (canDm && d && !llm.looksInjected(d) && !/https?:|www\.|\d{6,}|微信|vx|qq群/i.test(d)) {
    const sent = await withBlock('live_dm', () => bili.sendLiveDanmaku(r.roomid, d)).catch((e) => {
      if (e.risk) throw e;
      current.dmOn = false; // 发不出去（没绑手机、等级不够、被禁言）就别再试了
      logAction({ kind: 'live', source: SRC, ok: false, target: r.roomid, error: e.message, detail: `想发弹幕没发出去，这场先不发了：${d}` });
      return null;
    });
    if (sent?.ok) {
      current.mine.push({ text: d, at: Date.now() });
      logAction({ kind: 'live_dm', source: SRC, target: r.roomid, detail: `在${r.uname}的直播间发了条弹幕：${d}` });
      res.dm = d;
    } else if (sent) logAction({ kind: 'live_dm', source: SRC, ok: false, target: r.roomid, detail: `弹幕被直播间屏蔽了（${sent.filtered}）：${d}` });
  }
  const say = String(out?.say || '').trim().slice(0, 80);
  if (canSay && say && !llm.looksInjected(say)) {
    current.said.push({ text: say, at: Date.now() });
    tell(say);
    res.say = say;
  }
  return res;
}

/** 给聊天的她看的：正陪号主看什么、直播间里这会儿在说什么；没在看是空的 */
export function companionText() {
  if (!current?.roomid) return '';
  const mins = Math.max(1, Math.round((Date.now() - current.startedAt) / 60_000));
  const dm = current.danmaku.slice(-10).map((d) => `  ${llm.fence(d.text, 30)}`).join('\n');
  return [
    `你${current.stay ? '正陪他一起' : '正在自己'}看 B站 直播（看了 ${mins} 分钟）：${llm.fence(current.uname, 30)}《${llm.fence(current.title, 60)}》${current.area ? `，${current.area}` : ''}`,
    current.seen && `画面里：${llm.fence(current.seen, 160)}`,
    dm && `弹幕这会儿在说：\n${dm}`,
    current.mine.length && `你发过的弹幕：${current.mine.slice(-3).map((d) => d.text).join(' / ')}`,
    current.stay && `弹幕：${current.dmOn ? '你在发（他说别发了就调 live_danmaku 关掉）' : '你没在发'}。他叫你出来就调 leave_live。`,
  ].filter(Boolean).join('\n');
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
    watching: current && { ...current, danmaku: current.danmaku.slice(-12), mine: current.mine.slice(-10), said: current.said.slice(-5) },
    recent,
  };
}
