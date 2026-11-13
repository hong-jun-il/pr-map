# 0006. 테스트에서는 `no-unsafe-*` 규칙을 끈다

- 상태: 채택
- 날짜: 2026-11-13
- 관련: PR #14, `eslint.config.js`

## 배경

ESLint의 타입 기반 규칙 묶음(`recommendedTypeChecked`)을 넣자 `test/`에서 `any` 관련 오류가 60곳쯤 나왔습니다. 대부분 워크플로 YAML이나 CLI가 낸 JSON을 읽어 값을 비교하는 코드입니다.

## 결정

`test/**`에서는 `no-unsafe-assignment`, `no-unsafe-member-access`, `no-unsafe-call`, `no-unsafe-return`, `no-unsafe-argument`를 끕니다. `src/`와 `eval/`에서는 켜 둡니다.

## 근거

- 테스트에서 값이 예상과 다르면 `expect`가 실패하므로, `any`가 새도 잘못을 놓치지 않습니다.
- 60곳에 타입을 붙이면 테스트가 길어지고, 그 타입은 테스트 밖에서 쓰이지 않습니다.

## 버린 대안

- **읽는 곳마다 타입을 정의:** 위 이유로 하지 않았습니다.
- **규칙 묶음 전체를 테스트에서 끄기:** 기다리지 않은 Promise 같은 실수는 테스트에서도 잡아야 해서 다섯 규칙만 껐습니다.

## 다시 볼 조건

테스트가 `any` 때문에 틀린 값을 통과시킨 일이 생겼을 때
