/**
 * Configuration parsing tests.
 *
 * Everything the worker does is driven by `vars` and secrets that a human types
 * into `wrangler.jsonc` or pushes with `wrangler secret put`, so the failure modes
 * worth testing are the boring ones: a typo in an enum, a percentage where a
 * count was expected, an out-of-range number, a trailing slash in a base URL.
 * Each of those would otherwise surface as a confusing runtime error on the first
 * real message.
 */
import { describe, expect, it } from "vitest";
import { ConfigError, botReadiness, loadConfig, type Env } from "../src/config";

function envOf(vars: Record<string, string | undefined> = {}): Env {
  return { INSTANCE_SLUG: "6281234567890", ...vars } as unknown as Env;
}

describe("loadConfig — relay settings", () => {
  it("applies the documented defaults", () => {
    const config = loadConfig(envOf());
    expect(config.slug).toBe("6281234567890");
    expect(config.hmacMode).toBe("strict");
    expect(config.mediaMode).toBe("r2");
    expect(config.relayMode).toBe("relay");
    expect(config.inlineMaxBytes).toBe(90_000);
    expect(config.bot.mode).toBe("off");
  });

  it("rejects a slug that is not an E.164 number", () => {
    expect(() => loadConfig({ INSTANCE_SLUG: "+6281234567890" } as unknown as Env)).toThrow(ConfigError);
    expect(() => loadConfig({ INSTANCE_SLUG: "081234567890" } as unknown as Env)).toThrow(ConfigError);
  });

  it("strips a trailing slash from base URLs so paths can be appended", () => {
    const config = loadConfig(
      envOf({
        WUZAPI_API_BASE: "https://wa.example.com/",
        AI_BASE_URL: "https://ai.example.com/v1///",
        PUBLIC_BASE_URL: "https://worker.example.com/",
      }),
    );
    expect(config.bot.wuzapiApiBase).toBe("https://wa.example.com");
    expect(config.bot.aiBaseUrl).toBe("https://ai.example.com/v1");
    expect(config.bot.publicBaseUrl).toBe("https://worker.example.com");
  });

  it("splits the HMAC keyring on commas and drops empties", () => {
    const config = loadConfig(envOf({ WUZAPI_HMAC_KEYS: " key-a , ,key-b, " }));
    expect(config.hmacKeys).toEqual(["key-a", "key-b"]);
  });
});

describe("loadConfig — automation settings", () => {
  it("reads the work plan defaults", () => {
    const { bot } = loadConfig(envOf());
    expect(bot.aiBaseUrl).toBe("");
    expect(bot.aiModel).toBe("");
    expect(bot.aiTimeoutMs).toBe(60_000);
    expect(bot.aiMaxTurns).toBe(3);
    expect(bot.knowledgeMode).toBe("auto");
    expect(bot.knowledgeInlineMaxBytes).toBe(1_048_576);
    expect(bot.knowledgeTopK).toBe(5);
    expect(bot.knowledgeHistoryLimit).toBe(10);
    expect(bot.contactSyncIntervalMinutes).toBe(10);
    expect(bot.paymentProvider).toBe("sumopod");
    expect(bot.paymentExpiresHours).toBe(24);
    expect(bot.paymentDryRun).toBe(true);
    expect(bot.telegramEnabled).toBe(false);
    expect(bot.maxItems).toBe(20);
    expect(bot.maxItemQty).toBe(99);
    expect(bot.outboxBatch).toBe(20);
    expect(bot.reconcileIntervalMinutes).toBe(1);
    expect(bot.voiceEnabled).toBe(false);
  });

  it.each([
    ["BOT_MODE", "on", "on"],
    ["BOT_MODE", "SHADOW", "shadow"],
    ["KNOWLEDGE_MODE", "r2_d1_fts", "r2_d1_fts"],
    ["PAYMENT_PROVIDER", "sumopod", "sumopod"],
  ])("accepts %s=%s", (name, raw, expected) => {
    const config = loadConfig(envOf({ [name]: raw }));
    const actual = name === "BOT_MODE" ? config.bot.mode : name === "KNOWLEDGE_MODE" ? config.bot.knowledgeMode : config.bot.paymentProvider;
    expect(actual).toBe(expected);
  });

  it("rejects an unknown enum value instead of silently falling back", () => {
    expect(() => loadConfig(envOf({ BOT_MODE: "yes" }))).toThrow(/BOT_MODE must be one of off, shadow, on/);
    expect(() => loadConfig(envOf({ KNOWLEDGE_MODE: "fts" }))).toThrow(/KNOWLEDGE_MODE must be one of/);
    expect(() => loadConfig(envOf({ PAYMENT_PROVIDER: "midtrans" }))).toThrow(/PAYMENT_PROVIDER must be one of/);
  });

  it("rejects a non-integer or out-of-range count", () => {
    expect(() => loadConfig(envOf({ AI_MAX_TURNS: "3.5" }))).toThrow(/AI_MAX_TURNS must be an integer/);
    expect(() => loadConfig(envOf({ KNOWLEDGE_TOP_K: "0" }))).toThrow(/KNOWLEDGE_TOP_K must be between 1 and 50/);
    expect(() => loadConfig(envOf({ AI_TIMEOUT_MS: "999999" }))).toThrow(/AI_TIMEOUT_MS must be between/);
  });

  it.each([
    ["true", true],
    ["TRUE", true],
    ["1", true],
    ["yes", true],
    ["false", false],
    ["0", false],
    ["no", false],
  ])("parses PAYMENT_DRY_RUN=%s as %s", (raw, expected) => {
    expect(loadConfig(envOf({ PAYMENT_DRY_RUN: raw })).bot.paymentDryRun).toBe(expected);
  });

  it("rejects a boolean that is neither", () => {
    expect(() => loadConfig(envOf({ TELEGRAM_ENABLED: "maybe" }))).toThrow(/TELEGRAM_ENABLED must be true or false/);
    expect(() => loadConfig(envOf({ VOICE_ENABLED: "on" }))).toThrow(/VOICE_ENABLED must be true or false/);
  });

  it("treats blank secrets as absent rather than as an empty string value", () => {
    const config = loadConfig(envOf({ AI_API_KEY: "   ", WUZAPI_TOKEN: "" }));
    expect(config.bot.aiApiKey).toBe("");
    expect(config.bot.wuzapiToken).toBe("");
  });
});

describe("botReadiness", () => {
  const readyVars = {
    WUZAPI_API_BASE: "https://wa.example.com",
    WUZAPI_TOKEN: "token",
    AI_BASE_URL: "https://ai.example.com/v1",
    AI_MODEL: "model",
    AI_API_KEY: "key",
  };

  const bindings = {
    BOT_DB: {} as D1Database,
    CHAT_COORDINATOR: {} as DurableObjectNamespace,
  };

  it("is ready when every secret and binding is present", () => {
    const config = loadConfig(envOf(readyVars));
    expect(botReadiness(config, bindings)).toEqual({ ready: true, missing: [], missingBindings: [] });
  });

  it("lists the missing secrets by name", () => {
    const config = loadConfig(envOf({ WUZAPI_API_BASE: "https://wa.example.com" }));
    const readiness = botReadiness(config, bindings);
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toEqual(["WUZAPI_TOKEN", "AI_BASE_URL", "AI_MODEL", "AI_API_KEY"]);
  });

  it("lists the missing bindings by name", () => {
    const config = loadConfig(envOf(readyVars));
    const readiness = botReadiness(config, {});
    expect(readiness.ready).toBe(false);
    expect(readiness.missingBindings).toEqual(["BOT_DB", "CHAT_COORDINATOR"]);
  });
});
