#!/usr/bin/env bash
# 변경 내용을 수집하고, 분석할 파일이 없으면 뒤 단계를 건너뛰게 한다.
set -euo pipefail

if [ -z "${PR_NUMBER:-}" ]; then
  echo "::error::PR Map 액션은 pull_request 이벤트에서만 실행할 수 있습니다."
  exit 1
fi

node "$GITHUB_ACTION_PATH/skill/pr-map/scripts/pr-map.js" collect --pr "$PR_NUMBER"

count=$(node -p "JSON.parse(require('fs').readFileSync('.pr-map/input.json', 'utf8')).files.length")
if [ "$count" = "0" ]; then
  echo "분석할 파일이 없어 건너뜁니다. 테스트도 분석하려면 .pr-map.yml에 includeTests: true를 넣으세요."
  echo "skip=true" >> "$GITHUB_OUTPUT"
fi
