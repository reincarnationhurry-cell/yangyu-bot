#!/bin/bash
# 建 / 更新「蓝色大肥鱼」专用的 DSH 配置（~/.dsh/profiles/yangyu），给面板查资料用。
#
#   ./panel/qq/dsh-profile/setup.sh
#
# 做的事：
#   1. 用 DSH 官方命令行，以官方 headless 模板建一个叫 yangyu 的配置（已有就跳过）
#   2. 把免费搜索插件链接到桌面版 DSH 已经装好的那份（不联网下载）
#   3. 写入同目录的 cordis.patch.yml：模型走本地网关，跑命令 / 读写文件这些工具全关
# 桌面版 DSH 升级、或者 dsh-free-search 更新之后，重跑一次就行。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DSH="${DSH_BIN:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"
HOME_DSH="${DSH_HOME:-$HOME/.dsh}"
P="$HOME_DSH/profiles/yangyu"
DESK="$HOME_DSH/profiles/desktop/node_modules"

[[ -x "$DSH" ]] || { echo "没找到 DSH 命令行：$DSH"; exit 1; }
[[ -d "$DESK/dsh-free-search" ]] || { echo "桌面版 DSH 里没装 dsh-free-search（插件市场里装一下）"; exit 1; }

if [[ ! -f "$P/package.json" ]]; then
  "$DSH" yangyu --from-default-profile headless --help >/dev/null
fi

node - "$P/package.json" <<'JS'
const fs = require('fs');
const f = process.argv[2];
const j = JSON.parse(fs.readFileSync(f, 'utf8'));
j.dependencies = { 'dsh-free-search': 'link:../desktop/node_modules/dsh-free-search' };
const b = j.dsh.profile.bundles.filter((x) => x !== 'dsh-codex-subscription');
if (!b.includes('dsh-free-search')) b.push('dsh-free-search');
j.dsh.profile.bundles = b;
fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
JS

[[ -f "$P/cordis.patch.yml" ]] && cp "$P/cordis.patch.yml" "$P/cordis.patch.yml.bak-$(date +%Y%m%d%H%M%S)"
cp "$HERE/cordis.patch.yml" "$P/cordis.patch.yml"
"$DSH" plugin --profile yangyu install --offline

# 核对：该关的工具都关了
"$DSH" --profile yangyu --dump-config > /tmp/yangyu-dump.$$ 2>/dev/null
for id in tool-bash tool-fs tool-fs-search tool-subagent tool-workflow tool-plugin-manager; do
  awk -v id="$id" '$0=="- id: "id{f=1;next} /^- id: /{f=0} f&&/disabled: true/{ok=1} END{exit ok?0:1}' /tmp/yangyu-dump.$$ \
    || { echo "⚠️ $id 没关掉，检查 cordis.patch.yml"; rm -f /tmp/yangyu-dump.$$; exit 1; }
done
rm -f /tmp/yangyu-dump.$$
echo "✓ 她专用的 DSH 配置好了：$P"
