#!/usr/bin/env bash
# 분석 에이전트의 하위 프로세스에서 API 키를 숨기는 격리(SUBPROCESS_ENV_SCRUB)에 bubblewrap이 필요하다.
# 격리를 끄면 PR 코드가 실행한 프로세스가 키를 읽을 수 있으므로, 준비하지 못하면 분석하지 않는다.
set -euo pipefail

works() {
  bwrap --unshare-user --ro-bind / / /bin/true >/dev/null 2>&1
}

if ! command -v bwrap >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq bubblewrap
fi

# Ubuntu 24.04부터 AppArmor가 일반 사용자의 네임스페이스를 막는다. bwrap에만 허용한다.
if ! works && [ -d /etc/apparmor.d ]; then
  bwrap_path=$(command -v bwrap)
  sudo tee /etc/apparmor.d/pr-map-bwrap >/dev/null <<EOF
abi <abi/4.0>,
include <tunables/global>
profile pr-map-bwrap $bwrap_path flags=(unconfined) {
  userns,
}
EOF
  sudo apparmor_parser -r /etc/apparmor.d/pr-map-bwrap
fi

if ! works; then
  echo "::error::bubblewrap을 실행할 수 없어 분석하지 않습니다. 이 실행 환경에서 사용자 네임스페이스를 허용하세요."
  exit 1
fi
echo "bubblewrap 준비 완료: $(bwrap --version)"
