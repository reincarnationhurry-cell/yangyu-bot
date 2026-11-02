// 每个测试文件第一个 import 它：把数据目录指到临时目录、去掉模型 Key，保证不碰真数据、不联网
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.YANGYU_DATA = mkdtempSync(join(tmpdir(), 'yangyu-test-'));
delete process.env.LLM_API_KEY;
// 测试绝不能真拉起 Chrome：指向一个不存在的路径，万一有用例走到开浏览器，立刻报错而不是弹个浏览器出来
process.env.WEB_BROWSER = join(process.env.YANGYU_DATA, 'no-browser-in-tests');
process.env.WEB_SHOW = '0';
export const DATA = process.env.YANGYU_DATA;
