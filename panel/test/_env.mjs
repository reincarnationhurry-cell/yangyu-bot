// 每个测试文件第一个 import 它：把数据目录指到临时目录、去掉模型 Key，保证不碰真数据、不联网
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.YANGYU_DATA = mkdtempSync(join(tmpdir(), 'yangyu-test-'));
delete process.env.LLM_API_KEY;
export const DATA = process.env.YANGYU_DATA;
