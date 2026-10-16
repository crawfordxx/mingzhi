#!/bin/bash
# 明知AI剪辑 启动入口（打进 zip 时改名为「明知AI剪辑.command」）：双击后在「终端」里前台运行启动器。
# 终端窗口就是「运行中」的标志：关闭这个窗口，或在窗口里按 Ctrl+C，即退出。
cd "$(dirname "$0")" || exit 1
echo "明知AI剪辑正在启动，浏览器会自动打开；关闭这个窗口即可退出。"
# 从网上下载的 zip 解压后，文件都带「隔离」标记；用户放行了这个 .command 之后，顺手清掉，
# 免得启动器二进制再被系统拦一次
xattr -dr com.apple.quarantine . 2>/dev/null
chmod +x ./mingzhi-launcher 2>/dev/null
./mingzhi-launcher
code=$?
echo
echo "明知AI剪辑已退出，可以关闭这个窗口。"
exit "$code"
