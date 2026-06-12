/**
 * ADR-119: ASR 模块单元测试。
 *
 * @see runtime/src/llm/asr.ts
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ASRConfig, isASREnabled, transcribeVoice } from "../src/llm/asr.js";

const enabledConfig: ASRConfig = {
  asrBaseUrl: "https://api.openai.com/v1",
  asrApiKey: "sk-test",
  asrModel: "whisper-1",
};

const disabledConfig: ASRConfig = {
  asrBaseUrl: "",
  asrApiKey: "",
  asrModel: "whisper-1",
};

describe("isASREnabled", () => {
  it("空 URL → false", () => {
    expect(isASREnabled({ asrBaseUrl: "", asrApiKey: "key", asrModel: "m" })).toBe(false);
  });

  it("空 Key → false", () => {
    expect(isASREnabled({ asrBaseUrl: "http://x", asrApiKey: "", asrModel: "m" })).toBe(false);
  });

  it("完整配置 → true", () => {
    expect(isASREnabled(enabledConfig)).toBe(true);
  });
});

describe("transcribeVoice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("禁用时返回 undefined", async () => {
    const result = await transcribeVoice(Buffer.from("data"), disabledConfig);
    expect(result).toBeUndefined();
  });

  it("空 buffer 返回 undefined", async () => {
    const result = await transcribeVoice(Buffer.alloc(0), enabledConfig);
    expect(result).toBeUndefined();
  });

  it("超大文件返回 undefined（> 10MB）", async () => {
    // 不真正分配 10MB——只需要 byteLength > 10_485_760
    const buf = Buffer.alloc(10_485_761);
    const result = await transcribeVoice(buf, enabledConfig);
    expect(result).toBeUndefined();
  });

  it("成功转写 → 返回文本", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: "好的我知道了 明天见" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await transcribeVoice(Buffer.from("fake-ogg-data"), enabledConfig);
    expect(result).toBe("好的我知道了 明天见");
    expect(mockFetch).toHaveBeenCalledOnce();

    // 验证请求 URL
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
  });

  it("API 错误（500）→ 返回 undefined", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Internal Server Error" }),
    );

    const result = await transcribeVoice(Buffer.from("data"), enabledConfig);
    expect(result).toBeUndefined();
  });

  it("网络异常 → 返回 undefined", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const result = await transcribeVoice(Buffer.from("data"), enabledConfig);
    expect(result).toBeUndefined();
  });

  it("空响应文本 → 返回 undefined", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: "" }),
      }),
    );

    const result = await transcribeVoice(Buffer.from("data"), enabledConfig);
    expect(result).toBeUndefined();
  });

  it("尾部斜线被去除", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: "hello" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await transcribeVoice(Buffer.from("data"), {
      ...enabledConfig,
      asrBaseUrl: "https://api.example.com/v1/",
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/audio/transcriptions");
  });
});
