import type { Problem } from "./validate";

// AI가 쓰는 짧은 근거 형식을 스키마가 검사하는 객체로 펼친다.
//   h:276 역할                  현재 파일의 head 276줄
//   b:10-12 역할                현재 파일의 base 10~12줄 (이름 변경 파일은 oldPath)
//   h:src/a.ts:10-12 역할       다른 파일의 head 근거
//   t:tests/a.test.ts:10-12 역할  테스트 연결 (항상 경로를 쓴다)
// 파일 경로가 없는 형식을 먼저 확인해 역할 안의 ":3 " 같은 글자를 경로로 읽지 않는다.
const LOCAL = /^([hb]):(\d+)(?:-(\d+))? (\S.*)$/;
const WITH_PATH = /^([hbt]):(.+?):(\d+)(?:-(\d+))? (\S.*)$/;

interface Ref {
  kind: string;
  path?: string;
  start: number;
  end: number;
  role: string;
}

function parseRef(text: string): Ref | null {
  const local = LOCAL.exec(text);
  if (local) {
    const [, kind, start, end, role] = local;
    return {
      kind: kind!,
      start: Number(start),
      end: Number(end ?? start),
      role: role!,
    };
  }
  const located = WITH_PATH.exec(text);
  if (!located) return null;
  const [, kind, path, start, end, role] = located;
  return {
    kind: kind!,
    path: path!,
    start: Number(start),
    end: Number(end ?? start),
    role: role!,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface FilePaths {
  head: unknown;
  base: unknown;
}

function expandEvidence(
  list: unknown,
  where: string,
  paths: FilePaths,
  problems: Problem[],
): void {
  if (!Array.isArray(list)) return;
  list.forEach((item, i) => {
    if (typeof item !== "string") return;
    const ref = parseRef(item);
    if (!ref || ref.kind === "t") {
      problems.push({
        path: `${where}[${i}]`,
        reason: `근거 형식이 아닙니다: ${JSON.stringify(item)}. 예: "h:276 역할", "b:10-12 역할", "h:src/a.ts:10-12 역할"`,
      });
      return;
    }
    const side = ref.kind === "h" ? "head" : "base";
    list[i] = {
      side,
      path: ref.path ?? paths[side],
      start: ref.start,
      end: ref.end,
      role: ref.role,
    };
  });
}

function expandTests(list: unknown, where: string, problems: Problem[]): void {
  if (!Array.isArray(list)) return;
  list.forEach((item, i) => {
    if (typeof item !== "string") return;
    const ref = parseRef(item);
    if (!ref || ref.kind !== "t") {
      problems.push({
        path: `${where}[${i}]`,
        reason: `테스트 연결 형식이 아닙니다: ${JSON.stringify(item)}. 예: "t:tests/a.test.ts:10-12 역할"`,
      });
      return;
    }
    list[i] = {
      path: ref.path,
      start: ref.start,
      end: ref.end,
      role: ref.role,
    };
  });
}

function expandNodes(
  nodes: unknown,
  where: string,
  paths: FilePaths,
  problems: Problem[],
): void {
  if (!Array.isArray(nodes)) return;
  nodes.forEach((node, i) => {
    if (!isRecord(node)) return;
    const at = `${where}[${i}]`;
    expandEvidence(node.evidence, `${at}.evidence`, paths, problems);
    if (isRecord(node.affectedBy))
      expandEvidence(
        node.affectedBy.evidence,
        `${at}.affectedBy.evidence`,
        paths,
        problems,
      );
    expandTests(node.tests, `${at}.tests`, problems);
    expandNodes(node.children, `${at}.children`, paths, problems);
  });
}

/**
 * 짧은 근거 문자열을 제자리에서 객체로 펼치고 형식 오류를 돌려준다.
 * 이미 객체인 항목은 그대로 두므로 전체 형식과 검증을 거친 파일도 그대로 읽는다.
 */
export function expandCompactRefs(map: unknown): Problem[] {
  const problems: Problem[] = [];
  if (!isRecord(map) || !Array.isArray(map.files)) return problems;
  map.files.forEach((file, i) => {
    if (!isRecord(file)) return;
    const paths = { head: file.path, base: file.oldPath ?? file.path };
    expandNodes(file.tree, `files[${i}].tree`, paths, problems);
  });
  return problems;
}
