# PR Map

PR의 변경을 파일별 자연어 동작 트리와 연결 관계로 보여주는 에이전트 스킬입니다. 설명 줄을 고르면 그 커밋의 원본 코드가 근거로 나타납니다.

## 사용

`skill/pr-map` 폴더를 `.claude/skills/pr-map`(저장소) 또는 `~/.claude/skills/pr-map`(개인)에 복사한 뒤, 분석할 저장소에서 실행합니다.

| 명령 | 동작 |
| --- | --- |
| `/pr-map`, `/pr-map <번호>` | 분석, 검증, 빌드 후 PR 댓글 게시 |
| `/pr-map view` | 뷰어 열기. 이때 새 커밋이 있는지 확인 |

필요한 도구는 Node 20 이상, `git`, `gh`(인증 완료)입니다. 분석은 실행 중인 에이전트의 모델이 하므로 API 키가 필요 없습니다.

결과는 `.pr-map/`에 저장됩니다. 코드 원문이 들어 있어서 `collect`가 이 클론의 `.git/info/exclude`에 등록해 커밋되지 않게 합니다.

### 설정: `.pr-map.yml` (선택)

```yaml
exclude:        # 지도에서 뺄 경로 (글롭)
  - docs/**
  - "**/*.gen.ts"
maxFiles: 50    # 넘으면 변경량이 작은 파일부터 미분류로 표시
includeTests: true  # 테스트도 지도에 넣기 (기본: 제외)
```

테스트 코드, 스토리, 테스트 러너 설정(`playwright`·`vitest`·`jest`·`cypress`)은 기본으로 지도에서 빠지고 미분류 목록에 남습니다.

## 범위

- **첫 버전:** 웹 뷰어, 로컬 스킬(`collect`·`validate`·`build`·`view`·`publish`), PR 댓글(Mermaid·접힘 트리·커밋 고정 링크).
- **호스팅 없음:** 전체 지도는 로컬에서 엽니다. 댓글은 GitHub 권한을 그대로 따르고, 코드 원문은 외부로 올리지 않습니다.
- **언어:** 관계 후보 추출과 구문 강조는 TS/JS 기준입니다. 다른 언어도 분석은 되지만 관계는 에이전트가 코드를 읽어 찾습니다.
- **다음 단계:** `setup` 마법사와 GitHub Actions 자동 실행, artifact 링크.

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
src/cli/         수집, 검증, 빌드, 댓글, 게시
src/viewer/      React 뷰어
samples/         시안의 예시 PR 분석 결과
test/            실제 git 저장소를 만들어 검증하는 테스트
design/          Claude Design 원본 시안
```
