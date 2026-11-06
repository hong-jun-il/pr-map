# PR Map

PR의 변경을 파일별 자연어 동작 트리와 연결 관계로 보여주는 에이전트 스킬입니다. 설명 줄을 고르면 그 커밋의 원본 코드가 근거로 나타납니다.

## 사용

`skill/pr-map` 폴더를 `.claude/skills/pr-map`(저장소) 또는 `~/.claude/skills/pr-map`(개인)에 복사한 뒤, 분석할 저장소에서 실행합니다.

| 명령                        | 동작                                               |
| --------------------------- | -------------------------------------------------- |
| `/pr-map`, `/pr-map <번호>` | 분석, 검증, 빌드 후 PR 댓글 게시                   |
| `/pr-map view`              | 뷰어 열기. 이때 새 커밋이 있는지 확인              |
| `/pr-map setup`             | 자동 실행 워크플로 설치 PR 생성, 시크릿 등록 안내  |
| `/pr-map clean`             | 이 클론의 `.pr-map/`과 `.git/info/exclude` 줄 삭제 |

필요한 도구는 Node 20 이상, `git`, `gh`(인증 완료)입니다. 분석은 실행 중인 에이전트의 모델이 하므로 API 키가 필요 없습니다.

`setup`은 `gh` 없이도 진행할 수 있습니다. 이때 PR과 시크릿은 출력된 링크에서 직접 만듭니다. 자동 실행은 GitHub Actions에서 돌기 때문에 저장소 시크릿 `ANTHROPIC_API_KEY`가 필요합니다. 액션 `hong-jun-il/pr-map@v1`이 게시되기 전에는 `setup --install`이 설치를 거부합니다.

결과는 `.pr-map/`에 저장됩니다. 코드 원문이 들어 있어서 `collect`가 이 클론의 `.git/info/exclude`에 등록해 커밋되지 않게 합니다.

### 자동 실행: `action.yml`

설치된 워크플로는 같은 저장소에서 연 PR만 분석합니다. 포크 PR, 초안, Dependabot PR과 `no-pr-map` 라벨이 붙은 PR은 건너뜁니다. 자동 실행은 PR 코드를 Anthropic API로 보내고, 사용량은 등록한 API 키에 청구됩니다.

| 입력                  | 기본값         | 설명                            |
| --------------------- | -------------- | ------------------------------- |
| `anthropic-api-key`   | 필수           | 저장소 시크릿으로 넘기는 API 키 |
| `github-token`        | `github.token` | PR 조회와 댓글 게시용 토큰      |
| `model`               | `sonnet`       | 분석 모델                       |
| `max-turns`           | `80`           | 에이전트의 최대 턴 수           |
| `max-budget-usd`      | `5`            | 실행당 비용 상한(추정치 기준)   |
| `claude-code-version` | `2.1.318`      | 설치할 Claude Code 버전         |

PR 코드는 신뢰할 수 없는 입력으로 다룹니다. 분석 단계에는 GitHub 토큰을 넘기지 않고, 네트워크 도구와 저장소의 `.claude` 설정, 훅, MCP를 끕니다. 쓰기는 `.pr-map/`으로 제한합니다. 전체 지도는 실행의 artifact(`pr-map-viewer`)로 14일 동안 보관하고, PR 댓글에 실행 페이지 링크를 넣습니다.

### 설정: `.pr-map.yml` (선택)

```yaml
exclude: # 지도에서 뺄 경로 (글롭)
  - docs/**
  - "**/*.gen.ts"
maxFiles: 50 # 넘으면 변경량이 작은 파일부터 미분류로 표시
includeTests: true # 테스트도 지도에 넣기 (기본: 제외)
```

테스트 코드, 스토리, 테스트 러너 설정(`playwright`·`vitest`·`jest`·`cypress`)은 기본으로 지도에서 빠지고 미분류 목록에 남습니다.

## 제거

1. 저장소마다 `/pr-map clean`을 실행해 코드 원문이 든 `.pr-map/`과 `.git/info/exclude` 줄을 지웁니다. 스킬을 먼저 지우면 이 명령을 쓸 수 없습니다.
2. 스킬을 지웁니다. `npx skills add`로 설치했다면 `npx skills remove pr-map`, 복사했다면 `.claude/skills/pr-map` 또는 `~/.claude/skills/pr-map` 폴더를 삭제합니다.
3. 자동 실행을 설치했다면 `.github/workflows/pr-map.yml`을 삭제해 커밋하고, 다른 곳에서 쓰지 않는 키라면 `gh secret delete ANTHROPIC_API_KEY`로 시크릿을 지웁니다.

PR에 달린 댓글은 다른 사람도 보는 기록이라 자동으로 지우지 않습니다. 필요하면 GitHub에서 직접 삭제하세요.

## 범위

- **첫 버전:** 웹 뷰어, 로컬 스킬(`collect`·`validate`·`build`·`view`·`publish`), PR 댓글(Mermaid·접힘 트리·커밋 고정 링크).
- **호스팅 없음:** 전체 지도는 로컬이나 Actions artifact로 엽니다. 댓글은 GitHub 권한을 그대로 따르고, PR Map이 코드 원문을 별도 서버에 올리지 않습니다.
- **언어:** 관계 후보 추출과 구문 강조는 TS/JS 기준입니다. 다른 언어도 분석은 되지만 관계는 에이전트가 코드를 읽어 찾습니다.

## 개발

```bash
npm install
npm test            # 번들 후 전체 테스트
npm run typecheck
npm run demo        # 시안의 예시 PR을 임시 저장소로 만들어 뷰어를 연다 (--stale: 새 커밋 상태)
```

`npm run build`가 `src/`를 `skill/pr-map/scripts/pr-map.js`와 `skill/pr-map/assets/viewer.html`로 번들합니다. 스킬 폴더는 설치 후 의존성 없이 실행되어야 하므로, 이 생성 파일들도 함께 배포합니다.

```text
spec/            스키마, 예시, validate 규칙 (AI 출력 계약)
skill/pr-map/    배포물: SKILL.md + 번들
action.yml       GitHub Actions 액션 (action/의 스크립트를 실행)
src/cli/         수집, 검증, 빌드, 댓글, 게시, 삭제
src/viewer/      React 뷰어
samples/         시안의 예시 PR 분석 결과
test/            실제 git 저장소를 만들어 검증하는 테스트
design/          Claude Design 원본 시안
```
