#!/usr/bin/env bash
# 공급자별 분석을 실행한다. PR 코드는 신뢰할 수 없는 입력이다.
set -euo pipefail

here="$GITHUB_ACTION_PATH/action"
# script와 api_key는 아래에서 source로 읽는 공급자 스크립트가 쓴다.
# shellcheck disable=SC2034
script="$GITHUB_ACTION_PATH/skill/pr-map/scripts/pr-map.js"

# 키를 내보내지 않는 변수로 옮겨, 에이전트 실행 명령에만 붙인다.
# shellcheck disable=SC2034
api_key="$PR_MAP_API_KEY"
unset PR_MAP_API_KEY

# 권한 규칙 없이 읽을 수 있도록 지시문과 스키마를 작업 폴더로 복사한다.
rm -rf .pr-map/skill
mkdir -p .pr-map/skill
cp "$GITHUB_ACTION_PATH/skill/pr-map/SKILL.md" .pr-map/skill/SKILL.md
cp -R "$GITHUB_ACTION_PATH/skill/pr-map/spec" .pr-map/skill/spec

case "$PR_MAP_PROVIDER" in
  claude)
    # shellcheck source=action/providers/claude.sh
    source "$here/providers/claude.sh"
    ;;
  codex | gemini)
    # 공급자 이름으로 파일을 고르므로 shellcheck가 따라갈 수 없다.
    # shellcheck source=/dev/null
    source "$here/providers/$PR_MAP_PROVIDER.sh"
    # shellcheck source=action/read-only-analysis.sh
    source "$here/read-only-analysis.sh"
    ;;
  *)
    echo "::error::지원하지 않는 공급자입니다: $PR_MAP_PROVIDER"
    exit 1
    ;;
esac
