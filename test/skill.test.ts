import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const skill = readFileSync("skill/pr-map/SKILL.md", "utf8");
const setup = readFileSync("skill/pr-map/references/setup.md", "utf8");

describe("스킬 지시문 분리", () => {
  it("분석 때 읽는 SKILL.md에는 설치 절차를 싣지 않는다", () => {
    expect(skill).not.toContain("## 자동 실행 설치");
    expect(skill).not.toContain("setup --install");
    expect(skill).not.toContain("setup --secret-from-env");
  });

  it("setup 명령은 분리한 절차를 읽게 한다", () => {
    expect(skill).toMatch(/`\/pr-map setup`\s*\|.*`references\/setup\.md`/);
  });

  it("분리한 절차에 설치 단계와 API 키 안전 규칙이 남아 있다", () => {
    expect(setup).toContain("**API 키 값을 다루지 않는다.**");
    expect(setup).toContain("setup --install");
    expect(setup).toContain("setup --secret-from-env");
    expect(setup).toContain("자기 터미널에서");
  });
});
