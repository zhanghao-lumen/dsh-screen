#!/bin/bash
# 构建并安装菜单栏小程序（~/Applications/DSH Screen.app + 登录自启）。
# 用法：scripts/install-menubar.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Applications/DSH Screen.app"
BIN="$ROOT/native/bin/dsh-screen-menubar"
CACHE="$ROOT/.cache"

mkdir -p "$CACHE/clang" "$CACHE/tmp"
export TMPDIR="$CACHE/tmp"

echo "==> 编译"
xcrun --sdk macosx swiftc -O -swift-version 5 \
  -module-cache-path "$CACHE/clang" \
  -target arm64-apple-macos14.0 \
  "$ROOT/native/menubar.swift" -o "$BIN" \
  -framework AppKit -framework Carbon

echo "==> 打包 app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/dsh-screen-menubar"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>DSH Screen</string>
  <key>CFBundleIdentifier</key><string>com.zhanghao.dsh-screen.menubar</string>
  <key>CFBundleExecutable</key><string>dsh-screen-menubar</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

echo "==> 登录自启"
PLIST_FILE="$HOME/Library/LaunchAgents/com.zhanghao.dsh-screen.menubar.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST_FILE" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.zhanghao.dsh-screen.menubar</string>
  <key>ProgramArguments</key>
  <array><string>$APP/Contents/MacOS/dsh-screen-menubar</string></array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardErrorPath</key><string>/tmp/dsh-screen-menubar.err</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)" "$PLIST_FILE" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_FILE"
echo "==> 完成：菜单栏出现「○ 屏幕」，快捷键 ⌥⌘D 开关学习模式"
