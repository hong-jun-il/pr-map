#!/usr/bin/env bash
# 선택한 공급자의 CLI를 고정 버전으로 설치한다.
set -euo pipefail

case "$PR_MAP_PROVIDER" in
  claude) package="@anthropic-ai/claude-code@${PR_MAP_CLI_VERSION:-2.1.318}" ;;
  codex) package="@openai/codex@${PR_MAP_CLI_VERSION:-0.167.0}" ;;
  gemini) package="@google/gemini-cli@${PR_MAP_CLI_VERSION:-0.67.0}" ;;
  *)
    echo "::error::지원하지 않는 공급자입니다: $PR_MAP_PROVIDER"
    exit 1
    ;;
esac
npm install -g "$package"
