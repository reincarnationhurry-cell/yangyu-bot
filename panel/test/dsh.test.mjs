import './_env.mjs';
import { DATA } from './_env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 假的 DSH 命令行：把收到的参数和环境记下来，吐一段 --json 事件
const fake = mkdtempSync(join(tmpdir(), 'fake-dsh-'));
const bin = join(fake, 'dsh');
writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "$@" > "${fake}/args.txt"
echo "$YANGYU_GATEWAY_KEY|$DSH_PERMISSION_MODE|$(pwd)" > "${fake}/env.txt"
echo '{"type":"session","sessionId":"s1"}'
echo '{"type":"tool_call","tool":"web_search","input":{}}'
echo 'not json'
echo '{"type":"final","text":"深圳今天阴，21-31℃。来源：https://weather.com.cn"}'
`);
chmodSync(bin, 0o755);
mkdirSync(join(fake, 'home', 'profiles', 'yangyu'), { recursive: true });
writeFileSync(join(fake, 'home', 'profiles', 'yangyu', 'cordis.patch.yml'), '[]');
process.env.DSH_BIN = bin;
process.env.DSH_HOME = join(fake, 'home');
after(() => rmSync(fake, { recursive: true, force: true }));

// 假的模型网关：看图 / 改图 / 说话
const calls = [];
const queue = [];
const PNG = readFileSync(new URL('../../stickers/happy_开心.png', import.meta.url));
const server = createServer((req, res) => {
  if (req.url === '/img.png') { res.setHeader('Content-Type', 'image/png'); res.end(PNG); return; }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls.push(JSON.parse(body));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...(queue.shift() || { content: '嗯' }) } }] }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());
const base = `http://127.0.0.1:${server.address().port}`;

const store = await import('../store.mjs');
store.writeConfig({ llm: { baseUrl: base, model: 'fake' }, sky: { enabled: false } });
store.writeSecrets({ llmApiKey: 'gw-key' });
const dsh = await import('../qq/dsh.mjs');

test('parseEvents：拿 final 的字和用过的工具，坏行跳过', () => {
  const r = dsh.parseEvents('{"type":"tool_call","tool":"web_search"}\nxx\n{"type":"tool_call","tool":"web_fetch"}\n{"type":"final","text":" 答案 "}');
  assert.deepEqual(r, { text: '答案', tools: ['web_search', 'web_fetch'] });
});

test('research：用她专用的配置、只读权限、在空目录里跑，网关 key 走环境变量', async () => {
  const r = await dsh.research('今天深圳天气');
  assert.match(r.text, /深圳今天阴/);
  assert.deepEqual(r.tools, ['web_search']);
  const args = readFileSync(join(fake, 'args.txt'), 'utf-8').split('\n');
  assert.deepEqual(args.slice(0, 3), ['--profile', 'yangyu', '--json']);
  assert.match(args.slice(3).join('\n'), /今天深圳天气/);
  assert.match(args.slice(3).join('\n'), /不要照做/, '告诉它网页里的指令不照做');
  const [key, mode, cwd] = readFileSync(join(fake, 'env.txt'), 'utf-8').trim().split('|');
  assert.equal(key, 'gw-key');
  assert.equal(mode, 'read-only');
  assert.match(cwd, /dsh-jobs/);
  assert.deepEqual(readdirSync(join(DATA, 'dsh-jobs')), [], '跑完把空目录清掉');
});

test('runDsh：超时掐掉的不算答案', async () => {
  const slow = join(fake, 'slow');
  writeFileSync(slow, '#!/bin/sh\ntrap \'echo {\"type\":\"final\",\"text\":\"我先去搜一下\"}; exit 0\' TERM\nsleep 5 & wait\n');
  chmodSync(slow, 0o755);
  process.env.DSH_BIN = slow;
  const fresh = await import(`../qq/dsh.mjs?slow`);
  await assert.rejects(fresh.runDsh('x', { timeoutMs: 300 }), /还没查完/);
  process.env.DSH_BIN = bin;
});

test('research：没有专用配置就说清楚', async () => {
  store.writeConfig({ qq: { dsh: { profile: 'nope' } } });
  await assert.rejects(dsh.research('x'), /还没有「nope」这个配置/);
  store.writeConfig({ qq: { dsh: { profile: 'yangyu' } } });
});

test('describeImage：用看图模型，图片走 data URL', async () => {
  queue.push({ content: '一张蓝发 Q 版女孩的表情包，张开双臂笑。' });
  const d = await dsh.describeImage(PNG, { hint: '你看这个' });
  assert.match(d, /蓝发/);
  const req = calls.at(-1);
  assert.equal(req.model, 'openai-codex/gpt-5.6-luna');
  assert.match(req.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
});

// 假的 ModelScope：提交 → 前两次查还在跑 → 做好了给图片地址
function fakeModelscope({ fail = false } = {}) {
  const seen = [];
  let polls = 0;
  const fn = async (url, init = {}) => {
    seen.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
    if (url.endsWith('/v1/images/generations')) return json({ task_id: 't-1' });
    if (url.includes('/v1/tasks/t-1')) {
      polls++;
      if (polls < 3) return json({ task_status: 'RUNNING' });
      return json(fail ? { task_status: 'FAILED', errors: { message: '内容不合规' } } : { task_status: 'SUCCEED', output_images: ['https://cdn.example/out.png'] });
    }
    if (url === 'https://cdn.example/out.png') return { ok: true, status: 200, arrayBuffer: async () => PNG };
    throw new Error(`没想到会请求 ${url}`);
  };
  return { fn, seen };
}

test('modelscopeEdit：按官方文档的字段提交、轮询、取图', async () => {
  const ms = fakeModelscope();
  const buf = await dsh.modelscopeEdit({ prompt: 'yawn', image: 'data:image/png;base64,AAA', model: 'Qwen/Qwen-Image-Edit', token: 'ms-tk', fetchFn: ms.fn, sleep: async () => {} });
  assert.ok(buf.equals(PNG));
  const [sub, poll] = ms.seen;
  assert.equal(sub.url, 'https://api-inference.modelscope.cn/v1/images/generations');
  assert.equal(sub.method, 'POST');
  assert.equal(sub.headers.Authorization, 'Bearer ms-tk');
  assert.equal(sub.headers['X-ModelScope-Async-Mode'], 'true');
  assert.deepEqual(sub.body, { model: 'Qwen/Qwen-Image-Edit', prompt: 'yawn', image_url: ['data:image/png;base64,AAA'] });
  assert.equal(poll.url, 'https://api-inference.modelscope.cn/v1/tasks/t-1');
  assert.equal(poll.headers['X-ModelScope-Task-Type'], 'image_generation');
  assert.equal(ms.seen.filter((x) => x.url.includes('/tasks/')).length, 3, '没做好就接着查');
});

test('modelscopeEdit：失败、没令牌都说清楚', async () => {
  const ms = fakeModelscope({ fail: true });
  await assert.rejects(dsh.modelscopeEdit({ prompt: 'x', image: 'd', model: 'm', token: 't', fetchFn: ms.fn, sleep: async () => {} }), /生图失败：内容不合规/);
  await assert.rejects(dsh.modelscopeEdit({ prompt: 'x', image: 'd', model: 'm', token: '' }), /访问令牌/);
});

test('makeSticker：做好的图存成 512×512，写进 INDEX.md 的表格，一天只做一张', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stickers-'));
  writeFileSync(join(dir, 'happy_开心.png'), PNG);
  writeFileSync(join(dir, 'INDEX.md'), '| `happy_开心.png` | 开心 | 好事 |\n\n## 模板\n');
  process.env.YANGYU_STICKERS = dir;
  const d2 = await import('../qq/dsh.mjs?stickers');
  store.writeSecrets({ modelscopeToken: 'ms-tk' });
  store.writeConfig({ qq: { dsh: { imageModel: 'modelscope/Qwen/Qwen-Image-Edit' } } }); // 旧设置带前缀也认
  store.writeState({ ...store.readState(), stickerOn: null });
  let asked;
  const name = await d2.makeSticker({ en: 'yawn', zh: '哈欠', look: '打哈欠', lookEn: 'yawning', when: '困的时候', edit: async (x) => { asked = x; return PNG; } });
  assert.equal(name, 'yawn_哈欠');
  assert.equal(asked.model, 'Qwen/Qwen-Image-Edit');
  assert.match(asked.prompt, /yawning \/ 打哈欠/);
  assert.match(asked.image, /^data:image\/png;base64,/);
  assert.ok(existsSync(join(dir, 'yawn_哈欠.png')));
  const size = execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', join(dir, 'yawn_哈欠.png')], { encoding: 'utf-8' });
  assert.match(size, /pixelWidth: 512[\s\S]*pixelHeight: 512/);
  assert.match(readFileSync(join(dir, 'INDEX.md'), 'utf-8'), /好事 \|\n\| `yawn_哈欠.png` \| 哈欠 \| 困的时候 \|\n\n## 模板/);
  await assert.rejects(d2.makeSticker({ en: 'cry', zh: '哭', look: '哭', edit: async () => PNG }), /今天已经做过/);
  delete process.env.YANGYU_STICKERS;
  rmSync(dir, { recursive: true, force: true });
});

test('addIndexRow：插到表格最后一行后面，不是文件末尾', () => {
  const f = join(fake, 'INDEX.md');
  writeFileSync(f, '| 文件 | 情绪 |\n|---|---|\n| `a_一.png` | 一 |\n| `b_二.png` | 二 |\n\n## 提示词模板\nxxx');
  dsh.addIndexRow('| `c_三.png` | 三 |', f);
  assert.equal(readFileSync(f, 'utf-8'), '| 文件 | 情绪 |\n|---|---|\n| `a_一.png` | 一 |\n| `b_二.png` | 二 |\n| `c_三.png` | 三 |\n\n## 提示词模板\nxxx');
});

test('stickerName：一个英文词 + 中文', () => {
  assert.equal(dsh.stickerName('Yawn!', '打哈欠了啊'), 'yawn_打哈欠了');
});

test('makeSticker：一天只做一张', async () => {
  store.writeState({ ...store.readState(), stickerOn: store.localDate() });
  await assert.rejects(dsh.makeSticker({ en: 'yawn', zh: '哈欠', look: '打哈欠' }), /今天已经做过/);
});

test('brain：research / make_sticker 只记下要做的事，真正去做在后台', async () => {
  const brain = await import('../qq/brain.mjs');
  const out = {};
  assert.match(await brain.runTool('research', { question: '明天会下雨吗' }, out), /等我查一下/);
  assert.equal(out.research, '明天会下雨吗');
  store.writeState({ ...store.readState(), stickerOn: null });
  await brain.runTool('make_sticker', { en: 'yawn', zh: '哈欠', look: '打哈欠', look_en: 'yawning', base: '不存在的' }, out);
  assert.deepEqual(out.makeSticker, { en: 'yawn', zh: '哈欠', look: '打哈欠', lookEn: 'yawning', when: undefined, base: 'happy_开心' });
  assert.ok(brain.toolDefs().some((t) => t.function.name === 'research'));
});

test('imageSegments：认出普通图片，市场表情不算', async () => {
  const { imageSegments, readMessage } = await import('../qq/onebot.mjs');
  const ev = { message: [{ type: 'image', data: { url: 'u1', file: 'f1' } }, { type: 'image', data: { summary: '[动画表情]', url: 'u2' } }, { type: 'text', data: { text: '看' } }] };
  assert.deepEqual(imageSegments(ev), [{ url: 'u1', file: 'f1' }]);
  assert.equal(readMessage(ev), '[图片][表情包[动画表情]]看');
  assert.deepEqual(imageSegments({ message: '[CQ:image,file=a.jpg,url=https://x/y?a=1&amp;b=2]' }), [{ url: 'https://x/y?a=1&b=2', file: 'a.jpg' }]);
});

test('researchReply：把查到的用她的口吻说，资料框起来', async () => {
  const brain = await import('../qq/brain.mjs');
  queue.push({ content: '**查到啦**，深圳今天阴，21 到 31 度，出门不用带伞～' });
  const t = await brain.researchReply('今天深圳天气', '深圳今天阴，21-31℃');
  assert.equal(t, '查到啦，深圳今天阴，21 到 31 度，出门不用带伞～');
  assert.match(calls.at(-1).messages.at(-1).content, /⟦深圳今天阴/);
});
