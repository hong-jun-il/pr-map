// claude -p --output-format stream-json 출력에서 턴별 도구 호출과 토큰, 마지막 결과를 뽑는다.

export interface ClaudeResult {
  is_error?: boolean;
  subtype?: string;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: Record<string, number>;
  modelUsage?: Record<string, unknown>;
  result?: string;
  permission_denials?: unknown[];
}

export interface TraceTurn {
  tools: { name: string; target: string }[];
  /** 이 턴에 모델이 읽은 입력 토큰 (캐시 읽기·쓰기 포함) */
  context: number;
}

export interface Trace {
  turns: TraceTurn[];
  /** validate가 지운 테스트 연결 수 */
  prunedTests: number;
  validateRuns: number;
}

interface Block {
  type?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | { text?: string }[];
}

interface StreamEvent extends ClaudeResult {
  type?: string;
  message?: {
    id?: string;
    usage?: Record<string, number>;
    content?: Block[] | string;
  };
}

export function readStream(stdout: string): {
  result: ClaudeResult | null;
  trace: Trace;
} {
  const byId = new Map<string, TraceTurn>();
  const trace: Trace = { turns: [], prunedTests: 0, validateRuns: 0 };
  let result: ClaudeResult | null = null;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let ev: StreamEvent;
    try {
      ev = JSON.parse(line) as StreamEvent;
    } catch {
      continue;
    }
    if (ev.type === "result") result = ev;
    const blocks = Array.isArray(ev.message?.content) ? ev.message.content : [];
    if (ev.type === "assistant") {
      // 한 응답이 내용 블록마다 따로 올 수 있어 응답 id로 묶는다.
      const id = ev.message?.id ?? String(byId.size);
      let turn = byId.get(id);
      if (!turn) {
        turn = { tools: [], context: 0 };
        byId.set(id, turn);
        trace.turns.push(turn);
      }
      const u = ev.message?.usage ?? {};
      turn.context =
        (u.input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0);
      for (const c of blocks) {
        if (c.type !== "tool_use") continue;
        const input = c.input ?? {};
        const raw = input.file_path ?? input.command ?? input.pattern;
        const target = typeof raw === "string" ? raw : "";
        turn.tools.push({ name: c.name ?? "", target: target.slice(0, 160) });
        if (/pr-map\.js validate/.test(target)) trace.validateRuns++;
      }
    }
    if (ev.type === "user") {
      for (const c of blocks) {
        if (c.type !== "tool_result") continue;
        const text =
          typeof c.content === "string"
            ? c.content
            : (c.content ?? []).map((x) => x.text ?? "").join("\n");
        trace.prunedTests += (text.match(/^테스트 연결 제거:/gm) ?? []).length;
      }
    }
  }
  return { result, trace };
}
