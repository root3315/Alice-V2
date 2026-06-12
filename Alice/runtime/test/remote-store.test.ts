/**
 * remote-store.ts 单元测试。
 *
 * 使用 vi.stubGlobal / vi.stubEnv mock 外部依赖（fetch, env），
 * 验证搜索、下载、发布、网络策略推导等核心逻辑。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════════════
// remote-store 函数测试
// ═══════════════════════════════════════════════════════════════════════════

describe("remote-store", () => {
  beforeEach(() => {
    vi.stubEnv("ALICE_STORE_URL", "https://store.example.com");
    vi.stubEnv("ALICE_STORE_TOKEN", "test-token-123");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("getRemoteStoreUrl / getRemoteStoreToken", () => {
    it("读取 ALICE_STORE_URL 环境变量", async () => {
      const { getRemoteStoreUrl } = await import("../src/skills/remote-store.js");
      expect(getRemoteStoreUrl()).toBe("https://store.example.com");
    });

    it("未设置时返回 null", async () => {
      vi.stubEnv("ALICE_STORE_URL", "");
      const mod = await import("../src/skills/remote-store.js");
      expect(mod.getRemoteStoreUrl()).toBeNull();
    });
  });

  describe("searchRemoteStore", () => {
    it("Store 未配置时返回 null", async () => {
      vi.stubEnv("ALICE_STORE_URL", "");
      const { searchRemoteStore } = await import("../src/skills/remote-store.js");
      const result = await searchRemoteStore("weather");
      expect(result).toBeNull();
    });

    it("正常搜索返回 Skill 列表", async () => {
      const mockSkills = [
        {
          name: "weather",
          version: "1.0.0",
          description: "天气查询",
          whenToUse: "查天气",
          hash: "abc123",
        },
      ];
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ skills: mockSkills }),
        }),
      );

      const { searchRemoteStore } = await import("../src/skills/remote-store.js");
      const result = await searchRemoteStore("weather");
      expect(result).toEqual(mockSkills);

      const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain("/api/v1/skills");
      expect(fetchCall[0]).toContain("query=weather");
    });

    it("HTTP 错误时返回 null（不抛异常）", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
        }),
      );

      const { searchRemoteStore } = await import("../src/skills/remote-store.js");
      const result = await searchRemoteStore();
      expect(result).toBeNull();
    });

    it("网络错误时返回 null（不抛异常）", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      const { searchRemoteStore } = await import("../src/skills/remote-store.js");
      const result = await searchRemoteStore();
      expect(result).toBeNull();
    });
  });

  describe("getRemoteSkillInfo", () => {
    it("正常返回 Skill 详情", async () => {
      const mockInfo = {
        name: "weather",
        version: "1.0.0",
        description: "天气",
        hash: "abc",
        manifest: { name: "weather" },
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockInfo),
        }),
      );

      const { getRemoteSkillInfo } = await import("../src/skills/remote-store.js");
      const result = await getRemoteSkillInfo("weather");
      expect(result).toEqual(mockInfo);
    });

    it("404 时返回 null", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

      const { getRemoteSkillInfo } = await import("../src/skills/remote-store.js");
      const result = await getRemoteSkillInfo("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("publishToRemoteStore", () => {
    it("未配置 ALICE_STORE_URL 时抛错", async () => {
      vi.stubEnv("ALICE_STORE_URL", "");
      const { publishToRemoteStore } = await import("../src/skills/remote-store.js");
      await expect(publishToRemoteStore("/tmp/fake.tar.gz", {})).rejects.toThrow("ALICE_STORE_URL");
    });

    it("未配置 ALICE_STORE_TOKEN 时抛错", async () => {
      vi.stubEnv("ALICE_STORE_TOKEN", "");
      const { publishToRemoteStore } = await import("../src/skills/remote-store.js");
      await expect(publishToRemoteStore("/tmp/fake.tar.gz", {})).rejects.toThrow(
        "ALICE_STORE_TOKEN",
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// inferNetworkPolicy 测试
// ═══════════════════════════════════════════════════════════════════════════

describe("inferNetworkPolicy", () => {
  it("默认返回 false（所有 capabilities 走 Unix socket）", async () => {
    const { inferNetworkPolicy } = await import("../src/skills/compiler.js");

    expect(inferNetworkPolicy({})).toBe(false);
  });

  it("runtime.network 显式声明 true 时启用外网", async () => {
    const { inferNetworkPolicy } = await import("../src/skills/compiler.js");

    expect(
      inferNetworkPolicy({
        runtime: {
          backend: "shell",
          timeout: 30,
          network: true,
          isolation: "container",
          memory: "512m",
        },
      }),
    ).toBe(true);
  });

  it("runtime.network 显式声明 false 时禁用外网", async () => {
    const { inferNetworkPolicy } = await import("../src/skills/compiler.js");

    expect(
      inferNetworkPolicy({
        runtime: {
          backend: "shell",
          timeout: 30,
          network: false,
          isolation: "container",
          memory: "512m",
        },
      }),
    ).toBe(false);
  });
});
