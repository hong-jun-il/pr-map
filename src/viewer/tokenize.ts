export interface Token {
  t: string;
  c: string;
  italic?: boolean;
}

const RE =
  /(\/\/.*$|\/\*.*?\*\/|^\s*#.*$)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|\b(import|from|export|default|const|let|var|async|await|function|return|if|else|for|while|switch|case|break|continue|throw|new|try|catch|finally|class|extends|interface|type|enum|implements|public|private|protected|static|readonly|typeof|instanceof|in|of|as|this|super|void|true|false|null|undefined)\b|\b(\d[\d_.]*)\b|([A-Za-z_$][\w$]*)(?=\()/g;

/** 한 줄 단위의 가벼운 구문 강조. TS/JS에 맞췄고 다른 언어는 문자열·숫자·호출 정도만 맞는다. */
export function tokenize(line: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(line))) {
    if (m[0] === "") {
      RE.lastIndex++;
      continue;
    }
    if (m.index > last)
      out.push({ t: line.slice(last, m.index), c: "var(--fg)" });
    const c = m[1]
      ? "var(--fg3)"
      : m[2]
        ? "var(--syn-str)"
        : m[3]
          ? "var(--syn-kw)"
          : m[4]
            ? "var(--syn-num)"
            : "var(--syn-fn)";
    out.push({ t: m[0], c, italic: !!m[1] });
    last = RE.lastIndex;
  }
  if (last < line.length) out.push({ t: line.slice(last), c: "var(--fg)" });
  if (!out.length) out.push({ t: " ", c: "var(--fg)" });
  return out;
}
