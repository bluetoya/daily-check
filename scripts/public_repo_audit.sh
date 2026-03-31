#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() {
  echo "PUBLIC AUDIT FAILED: $1" >&2
  exit 1
}

echo "Running public repository audit..."

public_files=()

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  while IFS= read -r file; do
    public_files+=("$file")
  done < <(git ls-files --cached --others --exclude-standard)
else
  while IFS= read -r file; do
    public_files+=("${file#./}")
  done < <(
    find . \
      \( -path "./node_modules" -o -path "./sync-server/node_modules" -o -path "./dist" -o -path "./sync-server/dist" -o -path "./src-tauri/target" \) -prune -o \
      -type f \
      ! -name ".env.local" \
      ! -name ".env.*.local" \
      -print
  )
fi

filtered_public_files=()
for file in "${public_files[@]}"; do
  if [[ "$file" == "scripts/public_repo_audit.sh" ]]; then
    continue
  fi
  filtered_public_files+=("$file")
done
public_files=("${filtered_public_files[@]}")

for file in "${public_files[@]}"; do
  if [[ "$file" =~ (^|/)\.env($|\.) ]] && [[ ! "$file" =~ \.example$ ]]; then
    fail "민감한 환경파일이 공개 대상에 포함되어 있습니다: $file"
  fi
done

for file in "${public_files[@]}"; do
  if [[ "$file" =~ (^|/)(local\.properties|key\.properties|.*\.(jks|keystore))$ ]]; then
    fail "안드로이드 로컬 설정 또는 서명 파일이 공개 대상에 포함되어 있습니다: $file"
  fi
done

current_user="${USER:-}"
if [[ -n "$current_user" ]] && ((${#public_files[@]})) && rg -n \
  "com\\.${current_user}|authors = \\[\"${current_user}\"\\]|DATABASE_URL=postgres://${current_user}" \
  --glob '!scripts/public_repo_audit.sh' \
  -- "${public_files[@]}" >/dev/null; then
  fail "개인 식별자 또는 로컬 사용자 정보가 남아 있습니다."
fi

if ((${#public_files[@]})) && rg -n \
  "/Users/[A-Za-z0-9._-]+|/home/[A-Za-z0-9._-]+|C:\\\\Users\\\\[A-Za-z0-9._-]+" \
  --glob '!scripts/public_repo_audit.sh' \
  -- "${public_files[@]}" >/dev/null; then
  fail "절대 경로나 사용자 홈 디렉터리 정보가 남아 있습니다."
fi

if ((${#public_files[@]})) && rg -n \
  "\\b127\\.(?:\\d{1,3}\\.){2}\\d{1,3}\\b|\\b10\\.(?:\\d{1,3}\\.){2}\\d{1,3}\\b|\\b192\\.168\\.(?:\\d{1,3})\\.(?:\\d{1,3})\\b|\\b172\\.(?:1[6-9]|2\\d|3[0-1])\\.(?:\\d{1,3})\\.(?:\\d{1,3})\\b" \
  --glob '!scripts/public_repo_audit.sh' \
  -- "${public_files[@]}" >/dev/null; then
  fail "사설 IP 또는 루프백 IP 주소가 공개 코드에 남아 있습니다."
fi

if ((${#public_files[@]})) && rg -n \
  "BEGIN (RSA|EC|OPENSSH|PRIVATE) KEY|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}" \
  -- "${public_files[@]}" >/dev/null; then
  fail "비밀키나 민감 토큰으로 보이는 값이 남아 있습니다."
fi

echo "Public repository audit passed."
