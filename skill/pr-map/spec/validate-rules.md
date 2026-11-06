# validate 규칙 (스키마로 표현할 수 없는 것)

`pr.repo/number/base/head`를 `input.json` 값으로 덮어쓴 뒤, 스키마 검사 → 아래 규칙 순서로 실행한다. 실패 항목은 경로(`files[0].tree[1].children[0]`)와 이유를 담아 AI에 돌려준다.

## 참조

- `files[].id`는 PR 안에서 고유하다. 노드 `id`는 파일 안에서 고유하다.
- `edges[].from/to`, `replacedBy[]`는 존재하는 파일 `id`를 가리킨다.
- `readingOrder[].file`은 존재하는 파일 `id`를 가리키고, 중복될 수 없으며, `reference` 파일은 쓸 수 없다.
- 대체 관계는 `files[].replacedBy`에만 쓴다. 지도의 대체 엣지는 빌드할 때 이 값에서 만든다.

## 파일

- 변경 파일의 `status`와 `oldPath`는 `input.json` 값과 같다. `reference`는 변경되지 않은 파일에만 쓴다.
- 미분류 파일은 `files`에 넣지 않는다.
- 트리 깊이는 4단계 이하다.

## 근거 위치

- `start <= end`.
- `side`의 커밋(`base`=merge-base, `head`)에 `path`가 존재하고 `end`가 파일 줄 수 이하이다.
- 이름 변경 파일의 `base` 근거는 `oldPath`를 쓴다.

## 분기 상태와 근거의 일치

- `added`: 근거 중 하나 이상이 head의 `+` 줄과 겹친다. base 근거는 이전 구현을 보여주는 보조 근거로만 함께 쓸 수 있다.
- `deleted`: 모든 근거가 base이고 하나 이상이 `−` 줄과 겹친다.
- `modified`: 근거 중 하나 이상이 `+` 또는 `−` 줄과 겹친다.
- `affected`: 노드 근거는 변경 줄과 겹치지 않는다. `affectedBy.evidence`는 하나 이상이 변경 줄과 겹친다.
- `unchanged`: 근거가 변경 줄과 겹치지 않는다.
- 파일 상태 `added`의 노드는 모두 `added`, `deleted`의 노드는 모두 `deleted`.
- `unverified` 노드는 근거가 없으므로 위 일치 규칙에서 제외한다.

하위 분기만 바뀌고 자신의 코드는 그대로인 상위 노드는 `unchanged`다.

## 테스트 연결

`tests`는 근거 일치 규칙과 분리한다. 아래 조건을 어긴 연결은 실패로 처리하지 않고 지우며, 지운 내역을 로그로 남긴다. 테스트 연결이 틀렸다고 분기 설명까지 강등하지 않는다.

- 노드가 `added`, `modified`, `affected`이고 `unverified`가 아니다.
- `path`는 이번 PR에서 바뀐 테스트 파일이다 (`input.json`의 `files` 또는 `unclassified`).
- 범위가 head에 있고 `+` 줄과 겹친다. 바뀐 파일 안에 있어도 이번 PR에서 건드리지 않은 테스트는 연결하지 않는다.

## id 안정성 (재분석)

- 이전 `pr-map.json`이 있으면 AI 입력에 포함하고 "같은 동작이면 이전 id 유지"를 지시한다.
- 스크립트 보정: 새 id 노드 중 이전 노드와 근거 범위가 80% 이상 겹치고 같은 파일·같은 상위 노드인 것은 이전 id로 바꾼다. 바꾼 내역은 로그로 남긴다.

## 실패 처리

- 최대 3회 AI 수정. 이후에도 근거 위치·상태 규칙을 어긴 노드는 `evidence: []`, `unverified: true`로 강등하고 계속 진행한다. `affected` 노드는 `unchanged`로 함께 내린다.
- 스키마·참조 오류처럼 노드 강등으로 해결되지 않는 오류는 실패로 끝난다.
