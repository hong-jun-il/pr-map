#!/usr/bin/env bash
# analyze.sh가 읽는다. Gemini CLI는 셸 명령에서 키를 숨기는 방법이 확실하지 않아 셸을 아예 허용하지 않는다.
#   정책: 파일 읽기와 검색만 허용하고 나머지 도구는 모두 거부한다.
#   HOME: 설정과 정책을 임시 폴더로 고정한다.
# script, api_key, run_agent 같은 값은 이 파일을 source로 읽는 analyze.sh가 정한다.
# shellcheck disable=SC2154
gemini_home=$(mktemp -d)
mkdir -p "$gemini_home/.gemini/policies"
cat > "$gemini_home/.gemini/policies/pr-map.toml" <<'EOF'
[[rule]]
toolName = "*"
decision = "deny"
priority = 1

[[rule]]
toolName = ["read_file", "read_many_files", "list_directory", "glob", "search_file_content", "grep_search"]
decision = "allow"
priority = 100
EOF
cat > "$gemini_home/.gemini/settings.json" <<EOF
{ "model": { "maxSessionTurns": $PR_MAP_MAX_TURNS } }
EOF

# 인자: 프롬프트 파일, 답변을 저장할 파일
# 저장소 설정은 read-only-analysis.sh가 지운 뒤에 실행되므로 작업 폴더를 신뢰로 표시해도 읽을 설정이 없다.
run_agent() {
  local model_args=()
  [ -n "${PR_MAP_MODEL:-}" ] && model_args=(--model "$PR_MAP_MODEL")
  local raw="$2.raw"
  HOME="$gemini_home" GEMINI_API_KEY="$api_key" GEMINI_CLI_TRUST_WORKSPACE=true gemini \
    "${model_args[@]}" \
    --output-format json \
    -p "$(cat "$1")" > "$raw" 2> /dev/null || return 1
  node -e '
    const fs = require("fs");
    const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (r.error || typeof r.response !== "string") process.exit(1);
    fs.writeFileSync(process.argv[2], r.response);
  ' "$raw" "$2"
}
