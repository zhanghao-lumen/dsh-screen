#!/bin/bash
# 把本插件装进本机某个 DSH profile（默认 desktop）。
# 用法：scripts/install-local.sh [profile 名]
# 注意：Electron 应用独占 desktop profile，所以这个脚本直接改 profile 目录；
#       装完要重启应用才生效（bundle 列表在启动时读取）。
set -euo pipefail

PROFILE="${1:-desktop}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DIR="$DSH_HOME/profiles/$PROFILE"

[ -f "$DIR/package.json" ] || { echo "找不到 profile：$DIR"; exit 1; }

DST="$DIR/node_modules/dsh-screen"
TS=$(date +%Y%m%d-%H%M%S)
cp "$DIR/package.json" "$DIR/package.json.bak-$TS"

rm -rf "$DST"
mkdir -p "$DST/native/bin"
cp -R "$SRC/lib" "$DST/lib"
cp "$SRC/package.json" "$SRC/cordis.patch.yml" "$SRC/README.md" "$DST/"
for bin in cam rec whisper-server; do
  [ -f "$SRC/native/bin/$bin" ] && cp "$SRC/native/bin/$bin" "$DST/native/bin/"
done
chmod +x "$DST"/native/bin/* 2>/dev/null || true

python3 - "$DIR/package.json" <<'PY'
import json, sys
path = sys.argv[1]
manifest = json.load(open(path))
bundles = manifest.setdefault("dsh", {}).setdefault("profile", {}).setdefault("bundles", [])
if "dsh-screen" not in bundles:
    bundles.append("dsh-screen")
    with open(path, "w") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print("已加入 dsh.profile.bundles")
else:
    print("bundles 里已经有 dsh-screen")
PY

echo "已装到：$DST"
echo "重启 DSH 应用后生效；备份在：$DIR/package.json.bak-$TS"
