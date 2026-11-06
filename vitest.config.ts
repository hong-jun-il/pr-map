import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // 테스트마다 실제 git 저장소를 만들고 CLI를 프로세스로 실행한다.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
