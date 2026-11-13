#!/usr/bin/env bash
# analyze.sh가 읽는다. 읽기 전용 격리에서 실행하고, 지도는 최종 답변으로만 받는다.
#   shell_environment_policy: 셸 명령에 환경변수를 넘기지 않아 API 키를 숨긴다.
#   CODEX_HOME: 설정을 임시 폴더로 고정한다. 저장소의 Codex 설정은 쓰지 않는다.
# script, api_key, run_agent 같은 값은 이 파일을 source로 읽는 analyze.sh가 정한다.
# shellcheck disable=SC2154
codex_home=$(mktemp -d)
workspace=$(pwd -P)
cat > "$codex_home/config.toml" <<EOF
approval_policy = "never"
sandbox_mode = "read-only"

[shell_environment_policy]
inherit = "none"
ignore_default_excludes = false

[projects."$workspace"]
trust_level = "untrusted"
EOF

# 인자: 프롬프트 파일, 답변을 저장할 파일
run_agent() {
  local model_args=()
  [ -n "${PR_MAP_MODEL:-}" ] && model_args=(--model "$PR_MAP_MODEL")
  CODEX_HOME="$codex_home" CODEX_API_KEY="$api_key" codex exec \
    --sandbox read-only \
    --ephemeral \
    "${model_args[@]}" \
    --output-last-message "$2" \
    - < "$1" > /dev/null 2>&1
}
