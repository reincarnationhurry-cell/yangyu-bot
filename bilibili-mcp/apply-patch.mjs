#!/usr/bin/env node
/**
 * qq-bot bilibili-mcp 补丁脚本
 *
 * 用途：`npm install` / 升级 `bilibili-mcp-server` 后，node_modules 里的
 *       dist 会被覆盖，两个本地补丁会丢失。本脚本可重复执行，把它们重新打上。
 *
 * 用法：
 *   node apply-patch.mjs          # 打补丁（幂等）
 *   node apply-patch.mjs --check  # 只检查，不写入；返回 0=已打，1=未打
 *
 * 两个补丁：
 *   1. dist/api/wbi.js  —— 修复匿名态 WBI 密钥获取失败（code=-101 但有 wbi_img）
 *   2. dist/index.js    —— 服务端硬性只读闸门（屏蔽写工具，使其不进 tools/list）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, 'node_modules', 'bilibili-mcp-server', 'dist');
const checkOnly = process.argv.includes('--check');

const MARK_WBI = '[qq-bot patch] 未登录时 nav 返回 code=-101';
const MARK_INDEX = '[qq-bot patch] 服务端硬性只读闸门';

const patches = [
  {
    file: join(pkgRoot, 'api', 'login.js'),
    mark: '[qq-bot patch] 从 Set-Cookie 响应头解析登录凭证',
    find: `// ─── 请求辅助 ────────────────────────────────────────────
async function apiGet(url) {
    const res = await noProxyFetch(url, {
        headers: {
            'User-Agent': USER_AGENT,
            Referer: 'https://www.bilibili.com',
        },
        signal: AbortSignal.timeout(10_000),
    });
    return res.json();
}`,
    replace: `// ─── 请求辅助 ────────────────────────────────────────────
async function apiGet(url) {
    const res = await noProxyFetch(url, {
        headers: {
            'User-Agent': USER_AGENT,
            Referer: 'https://www.bilibili.com',
        },
        signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json();
    // [qq-bot patch] 保留原始响应，供需要读 Set-Cookie 的调用方使用
    return Object.assign(json, { __res: res });
}
/**
 * [qq-bot patch] 从 Set-Cookie 响应头解析登录凭证。
 *
 * 上游实现读的是 \`data.cookie_info\`，但 B站 passport 的 poll 接口**从不返回这个字段**，
 * 登录凭证只通过 Set-Cookie 响应头下发（SESSDATA / bili_jct / DedeUserID 等）。
 * 因此原代码即使扫码成功也只会返回「未获取到 Cookie 信息」，且什么都不保存。
 */
function cookiesFromResponse(res) {
    if (!res || typeof res.headers?.getSetCookie !== 'function') return null;
    const list = res.headers.getSetCookie();
    if (!list || list.length === 0) return null;
    const map = new Map();
    for (const raw of list) {
        const [pair] = raw.split(';');
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    const get = (name) => map.get(name) || '';
    const sessdata = get('SESSDATA');
    if (!sessdata) return null;
    return {
        sessdata,
        bili_jct: get('bili_jct'),
        dede_user_id: get('DedeUserID'),
        expires_in: get('SESSDATA_EXPIRES') || '',
    };
}`,
  },

  {
    file: join(pkgRoot, 'api', 'wbi.js'),
    mark: MARK_WBI,
    find: `    const json = (await resp.json());
    if (json.code !== 0 || !json.data?.wbi_img) {
        throw new Error(\`获取 WBI 密钥失败: code=\${json.code}\`);
    }`,
    replace: `    const json = (await resp.json());
    // [qq-bot patch] 未登录时 nav 返回 code=-101（账号未登录），但 data.wbi_img 仍然有效。
    // 原实现只要 code !== 0 就抛错，导致匿名状态下所有 WBI 接口（搜索/视频详情/用户信息）全挂。
    // 这里改为只校验 wbi_img 是否真实存在。
    if (!json.data?.wbi_img) {
        throw new Error(\`获取 WBI 密钥失败: code=\${json.code}\`);
    }`,
  },
  {
    file: join(pkgRoot, 'index.js'),
    mark: MARK_INDEX,
    find: `// ─── 注册所有工具 ─────────────────────────────────────────
registerCommentTools(server);`,
    replace: `// ─── 注册所有工具 ─────────────────────────────────────────
// [qq-bot patch] 服务端硬性只读闸门。
// DSH 的 dsh-mcp-client 不支持按工具白名单过滤，屏蔽只能在服务端做。
// 拦截点选在 registerTool 本身：写工具根本不会出现在 tools/list 里，
// 所以模型既看不到也调不到，不依赖提示词约束，无法被越狱绕过。
// 放开方式：设 BILIBILI_MCP_READONLY=false（同时需要有效的 SESSDATA/BILI_JCT）。
const READONLY = process.env.BILIBILI_MCP_READONLY !== 'false';
// 写操作工具名（发评论/弹幕/关注/私信/投稿/下载落盘/登录态写入）
const WRITE_TOOLS = new Set([
    'bilibili_reply',
    'bilibili_delete_comment',
    'bilibili_like_comment',
    'bilibili_send_danmaku',
    'bilibili_video_like',
    'bilibili_video_coin',
    'bilibili_video_favorite',
    'bilibili_user_follow',
    'bilibili_user_unfollow',
    'bilibili_login',
    'bilibili_login_check',
    'bilibili_refresh_cookie',
    'bilibili_video_download',
    'bilibili_article_download',
]);
const blockedTools = [];
if (READONLY) {
    const originalRegisterTool = server.registerTool.bind(server);
    server.registerTool = (name, ...rest) => {
        if (WRITE_TOOLS.has(name)) {
            blockedTools.push(name);
            return undefined;
        }
        return originalRegisterTool(name, ...rest);
    };
}
registerCommentTools(server);`,
  },
  {
    // [qq-bot patch] 上游 interaction.js 是纯占位（三个工具全部直接返回"API 已废弃"），
    // 且 index.js 完全没注册这个模块。这里整文件替换成 patches/interaction.js 里的真实实现。
    file: join(pkgRoot, 'tools', 'interaction.js'),
    mark: '[qq-bot patch] 上游把这个模块写成了纯占位',
    copyFrom: join(here, 'patches', 'interaction.js'),
  },
  {
    file: join(pkgRoot, 'index.js'),
    // mark 必须用 import 的完整行：只认「import 真的存在」。
    // 不能拿 registerInteractionTools(server); 当 mark——注释里也出现过这个名字，
    // import 被删掉时仍会误判为"已打补丁"（实测踩过这个坑）。
    mark: "import { registerInteractionTools } from './tools/interaction.js';",
    find: "import { registerDownloadTools } from './tools/download.js';",
    replace: `import { registerDownloadTools } from './tools/download.js';
// [qq-bot patch] 上游漏注册：interaction.js 实现了视频点赞/投币/收藏，
// 但 index.js 既没 import 也没调用 registerInteractionTools，导致 tools/list 里根本没有这三个工具。
import { registerInteractionTools } from './tools/interaction.js';`,
  },
  {
    file: join(pkgRoot, 'index.js'),
    mark: 'registerInteractionTools(server);\nregisterDownloadTools(server);',
    find: 'registerDownloadTools(server);',
    replace: 'registerInteractionTools(server);\nregisterDownloadTools(server);',
  },

  {
    // [qq-bot patch] 视频互动 API 换了现行 endpoint（上游用的是已废弃的 /x/v2/view/*）
    file: join(pkgRoot, 'api', 'bilibili.js'),
    mark: '[qq-bot patch] 上游用的 /x/v2/view/like 确实已废弃',
    find: `    async videoLike(params) {
        const cookie = getCookie();
        const body = {
            thumbs_up: String(params.action),
            csrf: cookie.bili_jct,
        };`,
    replace: `    // [qq-bot patch] 上游用的 /x/v2/view/like 确实已废弃（返回 -404/无此接口）。
    // 但「B站没有公开 endpoint」的判断是错的：现行可用接口是
    //   POST /x/web-interface/archive/like  参数 bvid/aid + like(1=赞 2=取消) + csrf
    // 已实测返回 code:0，且 /x/web-interface/archive/has/like 能正确反映状态。
    async videoLike(params) {
        const cookie = getCookie();
        const body = {
            // 上游传的是 thumbs_up（旧接口字段），新接口要 like
            like: params.action === 'like' ? '1' : '2',
            csrf: cookie.bili_jct,
        };`,
  },
  {
    file: join(pkgRoot, 'api', 'bilibili.js'),
    mark: "request('/x/web-interface/archive/like'",
    find: "return request('/x/v2/view/like', { method: 'POST', body });",
    replace: "// [qq-bot patch] 换到现行点赞接口\n        return request('/x/web-interface/archive/like', { method: 'POST', body });",
  },
  {
    file: join(pkgRoot, 'api', 'bilibili.js'),
    mark: "request('/x/web-interface/coin/add'",
    find: "            select_like: '0',\n            csrf: cookie.bili_jct,\n        };\n        if (/^BV/gi.test(params.videoId)) {\n            body.bvid = params.videoId;\n        }\n        else {\n            body.aid = params.videoId;\n        }\n        return request('/x/v2/view/coin', { method: 'POST', body });",
    replace: "            // [qq-bot patch] 上游硬编码 '0'；这里尊重 alsoLike 参数（1=投币同时点赞）\n            select_like: params.alsoLike ? '1' : '0',\n            csrf: cookie.bili_jct,\n        };\n        if (/^BV/gi.test(params.videoId)) {\n            body.bvid = params.videoId;\n        }\n        else {\n            body.aid = params.videoId;\n        }\n        return request('/x/web-interface/coin/add', { method: 'POST', body });",
  },
  {
    // [qq-bot patch] video_info 输出补打印 cid（发弹幕要用，上游没给，模型只能瞎猜）
    file: join(pkgRoot, 'tools', 'video.js'),
    mark: '[qq-bot patch] 补打印 cid',
    find: "                `分P数: ${data.videos || 1}`,\n                `发布时间: ${new Date(pubdateTs).toLocaleString('zh-CN')}`,",
    replace: "                `分P数: ${data.videos || 1}`,\n                // [qq-bot patch] 补打印 cid：发弹幕必须用它，但上游输出里没给，\n                // 导致模型只能瞎猜（实测乱填会返回 -400 请求错误）。\n                `aid: ${data.aid}  cid: ${data.cid}`,\n                `发布时间: ${new Date(pubdateTs).toLocaleString('zh-CN')}`,",
  },
];

let allApplied = true;
for (const p of patches) {
  let src;
  try {
    src = readFileSync(p.file, 'utf-8');
  } catch (err) {
    console.error(`✗ 读不到文件: ${p.file}\n  ${err.message}`);
    console.error('  先在该目录执行 npm install');
    process.exit(1);
  }

  if (src.includes(p.mark)) {
    console.log(`✓ 已打补丁: ${p.file}`);
    continue;
  }

  // 整文件替换模式：把 patches/ 下的模板整个拷过去
  if (p.copyFrom) {
    allApplied = false;
    if (checkOnly) {
      console.log(`✗ 未打补丁: ${p.file}`);
      continue;
    }
    try {
      writeFileSync(p.file, readFileSync(p.copyFrom, 'utf-8'), 'utf-8');
      console.log(`+ 已整文件替换: ${p.file}  ←  ${p.copyFrom}`);
    } catch (err) {
      console.error(`✗ 整文件替换失败: ${err.message}`);
      process.exit(1);
    }
    continue;
  }

  if (!src.includes(p.find)) {
    console.error(`✗ 找不到锚点（上游版本可能已变）: ${p.file}`);
    console.error('  请人工检查后再更新本脚本的 find/replace。');
    process.exit(1);
  }
  allApplied = false;
  if (checkOnly) {
    console.log(`✗ 未打补丁: ${p.file}`);
    continue;
  }
  writeFileSync(p.file, src.replace(p.find, p.replace), 'utf-8');
  console.log(`+ 已写入补丁: ${p.file}`);
}

if (checkOnly) process.exit(allApplied ? 0 : 1);
console.log('\n完成。重启 DSH 或等待插件 HMR 重载后生效。');
