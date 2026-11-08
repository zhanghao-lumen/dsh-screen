#!/bin/bash
# 构建原生依赖：whisper-server（本地转写）、rec（录音器）、cam（摄像头取帧）。
# 依赖：cmake、Xcode Command Line Tools（swiftc）。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
VENDOR="$ROOT/vendor"
BIN="$HERE/bin"
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"

mkdir -p "$BIN" "$VENDOR"

if [ ! -d "$VENDOR/whisper.cpp" ]; then
  echo "== 下载 whisper.cpp =="
  curl -fL --retry 3 https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/refs/heads/master -o /tmp/whisper-cpp.tar.gz
  mkdir -p "$VENDOR/whisper.cpp"
  tar xzf /tmp/whisper-cpp.tar.gz -C "$VENDOR/whisper.cpp" --strip-components=1
fi

echo "== 构建 whisper-server（静态链接 + Metal）=="
cmake -S "$VENDOR/whisper.cpp" -B "$VENDOR/whisper.cpp/build-static" \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
  -DGGML_METAL=ON -DGGML_OPENMP=OFF >/dev/null
cmake --build "$VENDOR/whisper.cpp/build-static" -j"$JOBS" --target whisper-server
cp "$VENDOR/whisper.cpp/build-static/bin/whisper-server" "$BIN/whisper-server"

echo "== 编译录音器 =="
swiftc -O -swift-version 5 "$HERE/rec.swift" -o "$BIN/rec" \
  -framework AVFoundation -framework CoreAudio

echo "== 构建 cam（摄像头取帧）=="
swiftc -O -swift-version 5 "$HERE/cam.swift" -o "$BIN/cam" \
  -framework AVFoundation -framework CoreImage
codesign --force --sign - "$BIN/cam" >/dev/null 2>&1 || true

echo "== 准备模型 =="
MODEL="$VENDOR/models/ggml-base.bin"
if [ ! -f "$MODEL" ]; then
  mkdir -p "$VENDOR/models"
  curl -fL --retry 3 https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.bin -o "$MODEL"
fi

ls -lh "$BIN"
echo "完成。包装到 profile 时记得带上 native/bin。"
