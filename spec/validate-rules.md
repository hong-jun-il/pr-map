# validate 규칙 (스키마로 표현할 수 없는 것)

`pr.repo/number/base/head`를 `input.json` 값으로 덮어쓴 뒤, 스키마 검사 → 아래 규칙 순서로 실행한다. 실패 항목은 경로(`files[0].tree[1].children[0]`)와 이유를 담아 AI에 돌려준다.

## 참조
- `files[].id`는 PR 안에서 고유하다. 노드 `id`는 파일 안에서 고유하다.
- `edges[].from/to`, `replacedBy[]`는 존재하는 파일 `id`를 가리킨다.
- `kind: "replacedBy"` 엣지는 `from` 파일이 `deleted`이고 `replacedBy`에 `to`가 있어야 한다.

## 파일
- 변경 파일의 `status`와 `oldPath`는 `input.json` 값과 같다. `reference`는 변경되지 않은 파일에만 쓴다.
- 미분류 파일은 `files`에 넣지 않는다.
- 트리 깊이는 4단계 이하다.

## 근거 위치
- `start <= end`.
- `side`의 커밋(`base`=merge-base, `head`)에 `path`가 존재하고 `end`가 파일 줄 수 이하이다.
- 이름 변경 파일의 `base` 근거는 `oldPath`를 쓴다.

## 분기 상태와 근거의 일치
- `added`: 근거 중 하나 이상이 head의 `+` 줄과 겹친다. base 근거 금지.
- `deleted`: 모든 근거가 base이고 하나 이상이 `−` 줄과 겹친다.
- `modified`: 근거 중 하나 이상이 `+` 또는 `−` 줄과 겹친다.
- `affected`: 노드 근거는 변경 줄과 겹치지 않는다. `affectedBy.evidence`는 하나 이상이 변경 줄과 겹친다.
- `unchanged`: 근거가 변경 줄과 겹치지 않는다.
- 파일 상태 `added`의 노드는 모두 `added`, `deleted`의 노드는 모두 `deleted`.
- `unverified` 노드는 근거가 없으므로 위 일치 규칙에서 제외한다.

하위 분기만 바뀌고 자신의 코드는 그대로인 상위 노드는 `unchanged`다. 뷰어는 하위에 변경이 있는 노드를 자동으로 펼친다.

## id 안정성 (재분석)
- 이전 `pr-map.json`이 있으면 AI 입력에 포함하고 "같은 동작이면 이전 id 유지"를 지시한다.
- 스크립트 보정: 새 id 노드 중 이전 노드와 근거 범위가 80% 이상 겹치고 같은 파일·같은 상위 노드인 것은 이전 id로 바꾼다. 바꾼 내역은 로그로 남긴다.

## 실패 처리
- 최대 3회 AI 수정. 이후에도 근거 위치·상태 규칙을 어긴 노드는 `evidence: []`, `unverified: true`로 강등하고 계속 진행한다. `affected` 노드는 `unchanged`로 함께 내린다.
- 스키마·참조 오류처럼 노드 강등으로 해결되지 않는 오류는 실패로 끝난다.
