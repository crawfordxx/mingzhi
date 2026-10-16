#!/usr/bin/env bash
# macOS 启动器打包、签名、公证：把 mingzhi-launcher 做成「明知AI剪辑.app」，打成 zip，
# 有 Developer ID 证书时签名（hardened runtime + 安全时间戳），再提交公证并钉合（staple）。
#
# 用法：
#   scripts/macos-sign.sh --bin <启动器二进制> --version <x.y.z> --arch <arm64|x64> [--out <目录，默认 dist>] [--sign-only]
#
# 环境变量（缺了就跳过对应步骤并打印说明，退出码仍为 0，不让没配 secrets 的 CI 失败）：
#   APPLE_SIGN_IDENTITY     签名身份，例如 "Developer ID Application: 名字 (TEAMID)"（也可以是证书哈希）
#   公证凭据，二选一：
#     MINGZHI_NOTARY_PROFILE                         xcrun notarytool store-credentials 存好的钥匙串配置名
#     APPLE_ID + APPLE_TEAM_ID + APPLE_APP_PASSWORD  Apple ID、团队 ID、App 专用密码
#
# 三种结果（zip 与 .sha256 都会产出）：
#   没有 APPLE_SIGN_IDENTITY      ad-hoc 签名（让 Apple 芯片能运行），不公证；用户首次打开要右键放行
#   有身份、没有完整公证凭据       Developer ID 签名，未公证（说明缺哪几项）
#   身份与公证凭据齐全             签名 + 公证 + 钉合，用户双击即可打开
# --sign-only：只签名，不公证（本机用 Apple Development 证书演练流程时用）
#
# 产物：<out>/Mingzhi-macos-<arch>.zip 与 .sha256（zip 内是 明知AI剪辑.app，ditto 打包，保留可执行位）。
# 公证被拒（Apple 返回的 status 不是 Accepted）时打印 Apple 的日志并以退出码 1 失败。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="明知AI剪辑.app"
EXE_NAME="mingzhi-launcher"
TEMPLATE="$ROOT/launcher/macos/Info.plist"
ENTITLEMENTS="$ROOT/launcher/macos/entitlements.plist"
ICON="$ROOT/launcher/macos/AppIcon.icns"

usage() {
  cat >&2 <<'USAGE'
用法：scripts/macos-sign.sh --bin <启动器二进制> --version <x.y.z> --arch <arm64|x64> [--out <目录，默认 dist>] [--sign-only]
环境变量：APPLE_SIGN_IDENTITY；公证用 MINGZHI_NOTARY_PROFILE，或 APPLE_ID + APPLE_TEAM_ID + APPLE_APP_PASSWORD
缺少环境变量时跳过签名/公证并以 0 退出。
USAGE
}

die_usage() {
  echo "错误：$1" >&2
  usage
  exit 2
}

BIN="" VERSION="" ARCH="" OUT="$ROOT/dist" SIGN_ONLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bin) [[ $# -ge 2 ]] || die_usage "--bin 缺少参数"; BIN="$2"; shift 2 ;;
    --version) [[ $# -ge 2 ]] || die_usage "--version 缺少参数"; VERSION="$2"; shift 2 ;;
    --arch) [[ $# -ge 2 ]] || die_usage "--arch 缺少参数"; ARCH="$2"; shift 2 ;;
    --out) [[ $# -ge 2 ]] || die_usage "--out 缺少参数"; OUT="$2"; shift 2 ;;
    --sign-only) SIGN_ONLY=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die_usage "不认识的参数 $1" ;;
  esac
done

[[ -n "$BIN" && -n "$VERSION" && -n "$ARCH" ]] || die_usage "--bin、--version、--arch 都必须给"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die_usage "版本号必须是 x.y.z 形式（得到 ${VERSION}）"
[[ "$ARCH" == arm64 || "$ARCH" == x64 ]] || die_usage "--arch 只能是 arm64 或 x64（得到 ${ARCH}）"
[[ -f "$BIN" ]] || die_usage "找不到启动器二进制 $BIN"
for f in "$TEMPLATE" "$ENTITLEMENTS" "$ICON"; do
  [[ -f "$f" ]] || { echo "错误：缺少 $f" >&2; exit 2; }
done

IDENTITY="${APPLE_SIGN_IDENTITY:-}"
PROFILE="${MINGZHI_NOTARY_PROFILE:-}"
APPLE_ID="${APPLE_ID:-}" TEAM_ID="${APPLE_TEAM_ID:-}" APP_PASSWORD="${APPLE_APP_PASSWORD:-}"

# 公证凭据缺哪几项
missing_notary() {
  local m=()
  [[ -n "$APPLE_ID" ]] || m+=(APPLE_ID)
  [[ -n "$TEAM_ID" ]] || m+=(APPLE_TEAM_ID)
  [[ -n "$APP_PASSWORD" ]] || m+=(APPLE_APP_PASSWORD)
  echo "${m[*]:-}"
}

NOTARIZE=0
if [[ -z "$IDENTITY" ]]; then
  echo "提示：未设置 APPLE_SIGN_IDENTITY，跳过 Developer ID 签名与公证。"
  echo "      产物只做 ad-hoc 签名，用户首次打开需要右键放行（见 README「首次打开」）。"
  echo "      要出正式签名包：在 CI secrets 里配置 Developer ID 证书与公证凭据，说明见本脚本开头的注释。"
elif [[ "$SIGN_ONLY" == 1 ]]; then
  echo "提示：指定了 --sign-only，仅签名，不公证。"
elif [[ -n "$PROFILE" ]]; then
  NOTARIZE=1
elif [[ -z "$(missing_notary)" ]]; then
  NOTARIZE=1
else
  echo "提示：公证凭据不全（缺 $(missing_notary)；或设置 MINGZHI_NOTARY_PROFILE），只签名、未公证，用户首次打开仍需右键放行。"
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
APP="$STAGE/$APP_NAME"

# ---- 1. 组装 .app
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/$EXE_NAME"
chmod 755 "$APP/Contents/MacOS/$EXE_NAME"
cp "$ICON" "$APP/Contents/Resources/AppIcon.icns"
sed "s/@VERSION@/$VERSION/g" "$TEMPLATE" > "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist" > /dev/null
# 清掉扩展属性（如 com.apple.provenance / quarantine）：codesign 会拒绝带这类杂质的包，zip 里也不该出现 ._ 文件
xattr -cr "$APP"

# ---- 2. 签名
if [[ -z "$IDENTITY" ]]; then
  codesign --force --sign - "$APP"
else
  # --timestamp：Apple 的安全时间戳，公证必需；--options runtime：hardened runtime，公证必需
  codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$APP"
fi
codesign --verify --strict --verbose=2 "$APP"

# ---- 3. 公证与钉合
if [[ "$NOTARIZE" == 1 ]]; then
  SUBMIT_ZIP="$STAGE/notarize.zip"
  ditto -c -k --keepParent --norsrc --noextattr --noacl "$APP" "$SUBMIT_ZIP"
  AUTH=()
  if [[ -n "$PROFILE" ]]; then
    AUTH=(--keychain-profile "$PROFILE")
  else
    AUTH=(--apple-id "$APPLE_ID" --team-id "$TEAM_ID" --password "$APP_PASSWORD")
  fi
  echo "提交公证并等待结果（通常几分钟）……"
  RC=0
  RESULT="$(xcrun notarytool submit "$SUBMIT_ZIP" --wait --output-format json "${AUTH[@]}" 2>&1)" || RC=$?
  STATUS="$(printf '%s' "$RESULT" | plutil -extract status raw -o - - 2>/dev/null || true)"
  if [[ "$STATUS" != "Accepted" ]]; then
    echo "公证失败（status=${STATUS:-未知}，退出码 ${RC}）：" >&2
    printf '%s\n' "$RESULT" >&2
    SUB_ID="$(printf '%s' "$RESULT" | plutil -extract id raw -o - - 2>/dev/null || true)"
    if [[ -n "$SUB_ID" ]]; then
      xcrun notarytool log "$SUB_ID" "${AUTH[@]}" >&2 || true
    fi
    exit 1
  fi
  echo "公证通过。"
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
fi

# ---- 4. 打包与校验和（钉合之后再打，zip 里的 .app 带公证票据）
mkdir -p "$OUT"
ZIP_NAME="Mingzhi-macos-$ARCH.zip"
ZIP="$OUT/$ZIP_NAME"
rm -f "$ZIP"
ditto -c -k --keepParent --norsrc --noextattr --noacl "$APP" "$ZIP"
(cd "$OUT" && shasum -a 256 "$ZIP_NAME" > "$ZIP_NAME.sha256")

echo "产物：$ZIP"
cat "$ZIP.sha256"
