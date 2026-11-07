# PR Map

PR의 변경을 파일별 동작 트리로 그리고, 모든 설명을 실제 코드 줄에 연결해 보여 주는 에이전트 스킬입니다. 리뷰어는 diff를 읽기 전에 PR이 무엇을 어떻게 바꾸는지 먼저 파악하고, 설명 줄을 고르면 그 커밋의 원본 코드를 근거로 바로 확인할 수 있습니다.

[실제 PR 댓글 예시 보기](https://github.com/hong-jun-il/pr-map/pull/2#issuecomment-6695611900)

## 설치

Node 20 이상, `git`, 로그인된 `gh`가 필요합니다.

1. 저장소를 내려받습니다.

   ```bash
   git clone --depth 1 --branch v1 https://github.com/hong-jun-il/pr-map.git /tmp/pr-map
   ```

2. 스킬 폴더를 복사합니다. 한 저장소에서만 쓰려면 `~/.claude/skills` 대신 그 저장소의 `.claude/skills`에 복사합니다.

   ```bash
   mkdir -p ~/.claude/skills && cp -R /tmp/pr-map/skill/pr-map ~/.claude/skills/pr-map
   ```

3. 내려받은 폴더를 지웁니다.

   ```bash
   rm -rf /tmp/pr-map
   ```

4. 분석할 저장소에서 에이전트를 열고 `/pr-map`을 실행합니다. 분석은 실행 중인 에이전트의 모델이 하므로 API 키가 필요 없습니다.

## 자동 실행 설정

PR이 열리거나 새 커밋이 올라올 때마다 자동으로 분석하려면, 분석할 저장소에서 다음을 실행합니다.

```text
/pr-map setup
```

에이전트가 다음 순서로 안내합니다.

1. 분석에 쓸 AI 공급자를 고릅니다.
2. 승인하면 워크플로 파일을 추가하는 설치 PR을 만듭니다. 작업 중인 브랜치는 건드리지 않습니다.
3. 고른 공급자의 API 키를 저장소 시크릿으로 등록합니다. 키는 채팅에 붙여넣지 말고 터미널이나 GitHub 설정에서 직접 등록하세요.
4. 설치 PR을 머지하면 다음 PR부터 자동으로 실행됩니다.

| 공급자 | 시크릿 이름         | 상태                 |
| ------ | ------------------- | -------------------- |
| Claude | `ANTHROPIC_API_KEY` | 실제 실행으로 확인함 |
| Codex  | `OPENAI_API_KEY`    | 실행 검증 전         |
| Gemini | `GEMINI_API_KEY`    | 실행 검증 전         |

자동 실행은 PR 코드를 고른 공급자의 API로 보내고, 사용량은 등록한 API 키에 청구됩니다. `gh`가 없어도 설정할 수 있으며, 이때는 PR과 시크릿을 출력된 링크에서 직접 만듭니다.

## 명령

| 명령                        | 동작                                                 |
| --------------------------- | ---------------------------------------------------- |
| `/pr-map`, `/pr-map <번호>` | PR을 분석하고 검증한 뒤 뷰어를 만들어 PR 댓글로 게시 |
| `/pr-map view`              | 뷰어를 열고, 그사이 새 커밋이 있는지 확인            |
| `/pr-map setup`             | 자동 실행 설치 PR을 만들고 시크릿 등록을 안내        |
| `/pr-map clean`             | 이 클론의 `.pr-map/`과 `.git/info/exclude` 줄을 삭제 |
| `/pr-map update`            | 새 버전을 확인하고, 승인하면 스킬 폴더를 교체        |

## 결과물

- **PR 댓글:** 변경 요약, 파일 연결 다이어그램, 파일별 동작 트리를 담습니다. 각 설명에는 해당 커밋의 코드 링크가 붙습니다.
- **뷰어:** 파일 간 연결과 동작 트리를 함께 보고, 설명 줄을 고르면 근거 코드를 확인합니다. 로컬에서는 `/pr-map view`로 열고, 자동 실행에서는 댓글의 `전체 지도 열기` 링크로 엽니다.

뷰어 링크를 열려면 GitHub에 로그인해야 하고, 링크는 14일 뒤 만료됩니다. 로컬 실행으로 올린 댓글에는 링크가 없고, PR을 체크아웃한 뒤 `/pr-map view`로 열어야 합니다.

분석 결과는 `.pr-map/`에 저장됩니다. 코드 원문이 들어 있어서 `collect`가 이 클론의 `.git/info/exclude`에 등록해 커밋되지 않게 합니다.

## 설정

### 분석 범위: `.pr-map.yml` (선택)

```yaml
exclude: # 지도에서 뺄 경로 (글롭)
  - docs/**
  - "**/*.gen.ts"
maxFiles: 50 # 넘으면 변경량이 작은 파일부터 미분류로 표시
includeTests: true # 테스트도 지도에 넣기 (기본: 제외)
```

테스트 코드, 스토리, 테스트 러너 설정(`playwright`·`vitest`·`jest`·`cypress`)은 기본으로 지도에서 빠지고 미분류 목록에 남습니다.

### 자동 실행 입력: `action.yml`

| 입력             | 기본값         | 설명                                   |
| ---------------- | -------------- | -------------------------------------- |
| `provider`       | `claude`       | `claude`, `codex`, `gemini`            |
| `api-key`        | 필수           | 저장소 시크릿으로 넘기는 API 키        |
| `github-token`   | `github.token` | PR 조회와 댓글 게시용 토큰             |
| `model`          | 공급자 기본값  | 분석 모델                              |
| `max-turns`      | `80`           | 최대 턴 수 (Claude, Gemini)            |
| `max-budget-usd` | `5`            | 실행당 비용 상한, 추정치 기준 (Claude) |
| `cli-version`    | 고정 버전      | 설치할 공급자 CLI 버전                 |

Codex와 Gemini는 비용 상한을 지원하지 않으므로 공급자 쪽 지출 한도를 설정하세요.

설치된 워크플로는 같은 저장소에서 연 PR만 분석합니다. 포크 PR, 초안, Dependabot PR과 `no-pr-map` 라벨이 붙은 PR은 건너뜁니다. 라벨 변경만으로는 다시 분석하지 않으므로, `no-pr-map`을 뗀 PR은 다음 푸시 때 분석합니다.

## 보안

PR 코드는 신뢰할 수 없는 입력으로 다룹니다.

- 분석 단계에는 GitHub 토큰을 넘기지 않습니다.
- Claude는 네트워크 도구와 저장소의 `.claude` 설정, 훅, MCP를 끄고, 쓰기를 `.pr-map/`으로 제한합니다.
- Codex와 Gemini는 코드를 읽기만 하고 지도를 답변으로 냅니다. 저장과 검증은 스크립트가 하고, 분석 전에 저장소의 `.codex`, `.gemini`, `AGENTS.md`, `GEMINI.md`를 일회용 체크아웃에서 지웁니다.
- PR Map은 코드 원문을 별도 서버에 올리지 않습니다. 뷰어는 로컬이나 해당 저장소의 Actions artifact에만 있습니다.
- 뷰어가 열린 뒤 주소창에 보이는 주소는 코드까지 볼 수 있는 임시 서명 주소입니다. 공유할 때는 주소창이 아니라 PR 댓글의 링크를 전달하세요.

## 제한

- 관계 후보 추출과 구문 강조는 TS/JS 기준입니다. 다른 언어도 분석은 되지만 관계는 에이전트가 코드를 읽어 찾습니다.
- 줄 위치는 커밋에서 검증하지만, 설명의 의미는 자동으로 검증하지 않습니다.

## 업데이트 알림

`collect`는 하루 한 번 GitHub의 `vX.Y.Z` 태그를 확인하고, 새 버전이 있으면 `publish`와 `view`가 끝날 때 한 줄로 알립니다. 확인에 실패해도 분석은 계속됩니다. CI에서는 확인하지 않고, `PR_MAP_NO_UPDATE_CHECK=1`로 끌 수 있습니다.

## 제거

1. 저장소마다 `/pr-map clean`을 실행해 코드 원문이 든 `.pr-map/`과 `.git/info/exclude` 줄을 지웁니다. 스킬을 먼저 지우면 이 명령을 쓸 수 없습니다.
2. 스킬을 지웁니다. `npx skills add`로 설치했다면 `npx skills remove pr-map`, 복사했다면 `.claude/skills/pr-map` 또는 `~/.claude/skills/pr-map` 폴더를 삭제합니다.
3. 자동 실행을 설치했다면 `.github/workflows/pr-map.yml`을 삭제해 커밋하고, 다른 곳에서 쓰지 않는 키라면 `gh secret delete ANTHROPIC_API_KEY`처럼 시크릿을 지웁니다.

PR에 달린 댓글은 다른 사람도 보는 기록이라 자동으로 지우지 않습니다. 필요하면 GitHub에서 직접 삭제하세요.

## 개발

```bash
npm install
npm test            # 번들 후 전체 테스트
npm run typecheck
npm run demo        # 시안의 예시 PR을 임시 저장소로 만들어 뷰어를 연다 (--stale: 새 커밋 상태)
```

`npm run build`가 `src/`를 `skill/pr-map/scripts/pr-map.js`와 `skill/pr-map/assets/viewer.html`로 번들합니다. 스킬 폴더는 설치 후 의존성 없이 실행되어야 하므로, 이 생성 파일들도 함께 배포합니다.

새 버전을 배포할 때는 `package.json`의 버전을 올려 빌드한 커밋에 같은 번호의 태그를 답니다.

```text
spec/            스키마, validate 규칙 (AI 출력 계약)
skill/pr-map/    배포물: SKILL.md + 번들
action.yml       GitHub Actions 액션 (action/의 스크립트를 실행)
src/cli/         수집, 검증, 빌드, 댓글, 게시, 삭제
src/viewer/      React 뷰어
test/            실제 git 저장소를 만들어 검증하는 테스트
test/fixtures/   테스트와 데모에 쓰는 예시 PR 분석 결과
```

뷰어 디자인 원본은 [Claude Design 프로젝트](https://claude.ai/design/p/55f2fe88-6c0a-4448-b278-e568ed4a0554?file=PR+Map+Lanes.dc.html)에 있습니다.

## 라이선스

[MIT](LICENSE)
