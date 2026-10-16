#!/usr/bin/env bash
# macOS 启动器打包、签名、公证：把启动器二进制（可给 arm64 与 x64 两个，用 lipo 合成通用二进制）
# 与「明知AI剪辑.command」一起打成 Mingzhi-macos.zip。用户双击 .command，在终端里运行启动器。
#
# 用法：
#   scripts/macos-sign.sh --bin <启动器二进制> [--bin <第二个二进制>] [--out <目录，默认 dist>] [--sign-only]
#
# 环境变量（缺了就跳过对应步骤并打印说明，退出码仍为 0，不让没配 secrets 的 CI 失败）：
#   APPLE_SIGN_IDENTITY     签名身份，例如 "Developer ID Application: 名字 (TEAMID)"（也可以是证书哈希）
#   公证凭据，二选一：
#     MINGZHI_NOTARY_PROFILE                         xcrun notarytool store-credentials 存好的钥匙串配置名
#     APPLE_ID + APPLE_TEAM_ID + APPLE_APP_PASSWORD  Apple ID、团队 ID、App 专用密码
#
# 三种结果（zip 与 .sha256 都会产出）：
#   没有 APPLE_SIGN_IDENTITY      启动器只做 ad-hoc 签名（让 Apple 芯片能运行），不公证
#   有身份、没有完整公证凭据       启动器用 Developer ID 签名，未公证（说明缺哪几项）
#   身份与公证凭据齐全             启动器签名 + 提交 zip 公证（Gatekeeper 联网核对公证票据）
# 只有二进制能签名：.command 是脚本，无法签名，首次打开仍要用户放行（见 README「首次打开」）；
# 打包时把签名后二进制的 sha256 写进 .command，它启动时先核对再去掉启动器的隔离标记；
# zip 与裸二进制也无法 staple，公证票据留在 Apple 服务器上。
# --sign-only：只签名，不公证（本机用 Apple Development 证书演练流程时用）
#
# 产物：<out>/Mingzhi-macos.zip 与 .sha256；zip 内是文件夹「明知AI剪辑」，里面有
#   明知AI剪辑.command 和 mingzhi-launcher（ditto 打包，保留可执行位）。
# 公证被拒（Apple 返回的 status 不是 Accepted）时打印 Apple 的日志并以退出码 1 失败，不产出 zip。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR_NAME="明知AI剪辑"
COMMAND_NAME="明知AI剪辑.command"
EXE_NAME="mingzhi-launcher"
ZIP_NAME="Mingzhi-macos.zip"
COMMAND_SRC="$ROOT/launcher/macos/start.command"
ENTITLEMENTS="$ROOT/launcher/macos/entitlements.plist"

usage() {
  cat >&2 <<'USAGE'
用法：scripts/macos-sign.sh --bin <启动器二进制> [--bin <第二个二进制>] [--out <目录，默认 dist>] [--sign-only]
环境变量：APPLE_SIGN_IDENTITY；公证用 MINGZHI_NOTARY_PROFILE，或 APPLE_ID + APPLE_TEAM_ID + APPLE_APP_PASSWORD
缺少环境变量时跳过签名/公证并以 0 退出。
USAGE
}

die_usage() {
  echo "错误：$1" >&2
  usage
  exit 2
}

BINS=() OUT="$ROOT/dist" SIGN_ONLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bin) [[ $# -ge 2 ]] || die_usage "--bin 缺少参数"; BINS+=("$2"); shift 2 ;;
    --out) [[ $# -ge 2 ]] || die_usage "--out 缺少参数"; OUT="$2"; shift 2 ;;
    --sign-only) SIGN_ONLY=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die_usage "不认识的参数 $1" ;;
  esac
done

[[ ${#BINS[@]} -ge 1 ]] || die_usage "至少给一个 --bin"
[[ ${#BINS[@]} -le 2 ]] || die_usage "--bin 最多给两个（arm64 与 x64）"
for b in "${BINS[@]}"; do
  [[ -f "$b" ]] || die_usage "找不到启动器二进制 ${b}"
done
for f in "$COMMAND_SRC" "$ENTITLEMENTS"; do
  [[ -f "$f" ]] || { echo "错误：缺少 ${f}" >&2; exit 2; }
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
  echo "      启动器只做 ad-hoc 签名，用户首次打开需要放行（见 README「首次打开」）。"
  echo "      要出正式签名包：在 CI secrets 里配置 Developer ID 证书与公证凭据，说明见本脚本开头的注释。"
elif [[ "$SIGN_ONLY" == 1 ]]; then
  echo "提示：指定了 --sign-only，仅签名，不公证。"
elif [[ -n "$PROFILE" ]]; then
  NOTARIZE=1
elif [[ -z "$(missing_notary)" ]]; then
  NOTARIZE=1
else
  echo "提示：公证凭据不全（缺 $(missing_notary)；或设置 MINGZHI_NOTARY_PROFILE），只签名、未公证，用户首次打开仍需放行。"
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
PKG="$STAGE/$DIR_NAME"
BIN="$PKG/$EXE_NAME"

# ---- 1. 组装文件夹：启动器二进制（两个就合成通用二进制）+ .command
mkdir -p "$PKG"
if [[ ${#BINS[@]} -eq 2 ]]; then
  lipo -create -output "$BIN" "${BINS[0]}" "${BINS[1]}"
else
  cp "${BINS[0]}" "$BIN"
fi
chmod 755 "$BIN"
# 清掉扩展属性（如 com.apple.provenance），zip 里不该出现 ._ 文件
xattr -cr "$PKG"

# ---- 2. 签名（只有二进制可以签）
if [[ -z "$IDENTITY" ]]; then
  codesign --force --sign - "$BIN"
else
  # --timestamp：Apple 的安全时间戳，公证必需；--options runtime：hardened runtime，公证必需
  codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$BIN"
fi
codesign --verify --strict --verbose=2 "$BIN"

# ---- 2b. 把签名后二进制的 sha256 写进 .command：它启动时先核对再去掉隔离标记，二进制被单独换掉就不会放行
SHA="$(shasum -a 256 "$BIN" | awk '{print $1}')"
sed "s/@LAUNCHER_SHA256@/$SHA/" "$COMMAND_SRC" > "$PKG/$COMMAND_NAME"
chmod 755 "$PKG/$COMMAND_NAME"
grep -q "^EXPECTED_SHA256=\"$SHA\"" "$PKG/$COMMAND_NAME" || { echo "错误：没能把 sha256 写进 $COMMAND_NAME" >&2; exit 1; }

# ---- 3. 打包；要公证的话提交的就是最终发布的这个 zip
ZIP="$STAGE/$ZIP_NAME"
ditto -c -k --keepParent --norsrc --noextattr --noacl "$PKG" "$ZIP"

if [[ "$NOTARIZE" == 1 ]]; then
  AUTH=()
  if [[ -n "$PROFILE" ]]; then
    AUTH=(--keychain-profile "$PROFILE")
  else
    AUTH=(--apple-id "$APPLE_ID" --team-id "$TEAM_ID" --password "$APP_PASSWORD")
  fi
  echo "提交公证并等待结果（通常几分钟）……"
  # stdout 只放 JSON 结果，stderr（进度、提示）单独存放，不混进要解析的内容；--timeout 防止排队时一直占着 CI
  RC=0
  RESULT="$(xcrun notarytool submit "$ZIP" --wait --timeout 30m --output-format json "${AUTH[@]}" 2>"$STAGE/notary.err")" || RC=$?
  STATUS="$(printf '%s' "$RESULT" | plutil -extract status raw -o - - 2>/dev/null || true)"
  if [[ "$STATUS" != "Accepted" ]]; then
    echo "公证失败（status=${STATUS:-未知}，退出码 ${RC}）：" >&2
    printf '%s\n' "$RESULT" >&2
    cat "$STAGE/notary.err" >&2
    SUB_ID="$(printf '%s' "$RESULT" | plutil -extract id raw -o - - 2>/dev/null || true)"
    if [[ -n "$SUB_ID" ]]; then
      xcrun notarytool log "$SUB_ID" "${AUTH[@]}" >&2 || true
    fi
    exit 1
  fi
  echo "公证通过（zip 与裸二进制无法钉合，Gatekeeper 会联网核对公证票据）。"
fi

# ---- 4. 输出与校验和
mkdir -p "$OUT"
cp "$ZIP" "$OUT/$ZIP_NAME"
(cd "$OUT" && shasum -a 256 "$ZIP_NAME" > "$ZIP_NAME.sha256")

echo "产物：$OUT/$ZIP_NAME"
cat "$OUT/$ZIP_NAME.sha256"
