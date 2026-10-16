#!/bin/bash
# 明知AI剪辑 启动入口（打进 zip 时改名为「明知AI剪辑.command」）：双击后在「终端」里前台运行启动器。
# 终端窗口就是「运行中」的标志：关闭这个窗口，或在窗口里按 Ctrl+C，即退出。
#
# 它会做的唯一一件「安全相关」的事：先核对同一文件夹里的 mingzhi-launcher 与发布时的 sha256 一致，
# 一致才去掉它和这个脚本自己的「来自互联网」隔离标记（不递归，不碰文件夹里的其它任何文件）。
# EXPECTED_SHA256 由 scripts/macos-sign.sh 在打包时写入。
EXPECTED_SHA256="@LAUNCHER_SHA256@"

SELF="./$(basename -- "$0")"
cd -- "$(dirname -- "$0")" || exit 1
echo "明知AI剪辑正在启动，浏览器会自动打开；关闭这个窗口即可退出。"

if [ ! -f ./mingzhi-launcher ]; then
  echo
  echo "找不到 mingzhi-launcher。请把整个「明知AI剪辑」文件夹解压后再双击，不要把这个文件单独移走。"
  exit 1
fi

ACTUAL_SHA256="$(shasum -a 256 ./mingzhi-launcher | awk '{print $1}')"
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  echo
  echo "mingzhi-launcher 与发布时的校验和不一致（文件可能损坏，或不是同一个版本里的文件），已停止。"
  echo "请重新从 Release 页面下载 Mingzhi-macos.zip。"
  exit 1
fi

xattr -d com.apple.quarantine ./mingzhi-launcher 2>/dev/null
xattr -d com.apple.quarantine "$SELF" 2>/dev/null
chmod +x ./mingzhi-launcher 2>/dev/null
./mingzhi-launcher
code=$?
# 退出码 10：已经有一个明知AI剪辑在运行，页面已交给它（启动器自己打印了说明）。
# 这个窗口不是「退出」，别再显示「已退出」，免得用户以为程序关了。
if [ "$code" -eq 10 ]; then
  exit 0
fi
echo
echo "明知AI剪辑已退出，可以关闭这个窗口。"
exit "$code"
