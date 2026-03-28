#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() {
  echo "PUBLIC AUDIT FAILED: $1" >&2
  exit 1
}

echo "Running public repository audit..."

while IFS= read -r file; do
  fail "민감한 환경파일이 남아 있습니다: $file"
done < <(
  find . \
    \( -path "./node_modules" -o -path "./sync-server/node_modules" -o -path "./dist" -o -path "./sync-server/dist" -o -path "./src-tauri/target" \) -prune -o \
    \( -name ".env" -o -name ".env.*" \) ! -name "*.example" -print
)

if rg -n "com\\.heejaeahn|authors = \\[\"heejaeahn\"\\]|DATABASE_URL=postgres://heejaeahn" \
  . \
  -g '!node_modules' \
  -g '!sync-server/node_modules' \
  -g '!dist' \
  -g '!sync-server/dist' \
  -g '!src-tauri/target' \
  -g '!scripts/public_repo_audit.sh' \
  >/dev/null; then
  fail "개인 식별자 또는 로컬 사용자 정보가 남아 있습니다."
fi

if rg -n "/Users/[A-Za-z0-9._-]+|/home/[A-Za-z0-9._-]+|C:\\\\Users\\\\[A-Za-z0-9._-]+" \
  . \
  -g '!node_modules' \
  -g '!sync-server/node_modules' \
  -g '!dist' \
  -g '!sync-server/dist' \
  -g '!src-tauri/target' \
  -g '!scripts/public_repo_audit.sh' \
  >/dev/null; then
  fail "절대 경로나 사용자 홈 디렉터리 정보가 남아 있습니다."
fi

if rg -n "\\b127\\.(?:\\d{1,3}\\.){2}\\d{1,3}\\b|\\b10\\.(?:\\d{1,3}\\.){2}\\d{1,3}\\b|\\b192\\.168\\.(?:\\d{1,3})\\.(?:\\d{1,3})\\b|\\b172\\.(?:1[6-9]|2\\d|3[0-1])\\.(?:\\d{1,3})\\.(?:\\d{1,3})\\b" \
  . \
  -g '!node_modules' \
  -g '!sync-server/node_modules' \
  -g '!dist' \
  -g '!sync-server/dist' \
  -g '!src-tauri/target' \
  -g '!scripts/public_repo_audit.sh' \
  >/dev/null; then
  fail "사설 IP 또는 루프백 IP 주소가 공개 코드에 남아 있습니다."
fi

if rg -n "BEGIN (RSA|EC|OPENSSH|PRIVATE) KEY|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}" \
  . \
  -g '!node_modules' \
  -g '!sync-server/node_modules' \
  -g '!dist' \
  -g '!sync-server/dist' \
  -g '!src-tauri/target' \
  -g '!scripts/public_repo_audit.sh' \
  >/dev/null; then
  fail "비밀키나 민감 토큰으로 보이는 값이 남아 있습니다."
fi

echo "Public repository audit passed."
