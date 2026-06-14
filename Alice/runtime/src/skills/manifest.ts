/**
 * Zod Schema для manifest.yaml пакета Skill — единственный источник истины для декларативного пакета Skill.
 *
 * Ментальная модель: Skill ≈ CLI-команда, LLM ≈ IRC-пользователь терминала.
 * manifest объявляет «имя команды + параметры + способ выполнения + формат stdout».
 *
 * @see docs/adr/200-skill-package-format.md
 * @see docs/adr/201-os-for-llm.md
 */

import { z } from "zod";
import { DockerIsolationSchema } from "./backends/docker.js";

// ═══════════════════════════════════════════════════════════════════════════
// Param Schema
// ═══════════════════════════════════════════════════════════════════════════

export const ManifestParamSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "array"]).default("string"),
  required: z.boolean().default(true),
  description: z.string(),
});

export type ManifestParam = z.infer<typeof ManifestParamSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Env Schema (объявление переменных окружения, требуемых Skill)
// ═══════════════════════════════════════════════════════════════════════════

export const EnvDeclSchema = z.object({
  name: z.string(),
  /** Имя поля в ActionImplContext, на которое маппится переменная. */
  contextKey: z.string().optional(),
  description: z.string().optional(),
});

// ═══════════════════════════════════════════════════════════════════════════
// Shell Backend — L2: дочерний процесс stdin/stdout (LLM = пользователь терминала)
// ═══════════════════════════════════════════════════════════════════════════

export const ShellBackendSchema = z.object({
  /** Шаблон команды для выполнения (поддерживает подстановку переменных {{param}}). */
  command: z.string(),
  /** Рабочая директория (относительно директории установки Skill). */
  cwd: z.string().optional(),
});

// ═══════════════════════════════════════════════════════════════════════════
// Runtime Schema
// ═══════════════════════════════════════════════════════════════════════════

export const RuntimeSchema = z.object({
  backend: z.enum(["shell", "mcp"]).default("shell"),
  timeout: z.number().default(30),
  network: z.boolean().default(true),
  /** Уровень изоляции: `container` — исторический псевдоним, разрешается в container profile по умолчанию. */
  isolation: z.enum(DockerIsolationSchema).default("container"),
  /** Ограничение памяти контейнера. */
  memory: z.string().default("512m"),
  env: z.array(EnvDeclSchema).optional(),
  shell: ShellBackendSchema.optional(),
});

export type SkillRuntime = z.infer<typeof RuntimeSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Family Schema (соответствует записям CAPABILITY_FAMILIES)
// ═══════════════════════════════════════════════════════════════════════════

export const FamilySchema = z.object({
  label: z.string(),
  whenToUse: z.string(),
  tutorials: z.array(z.string()).optional(),
});

// ═══════════════════════════════════════════════════════════════════════════
// Capability Schema (возможности Engine API, которые Skill может запросить)
// ═══════════════════════════════════════════════════════════════════════════

export const CapabilitySchema = z.enum([
  "chat.read",
  "config.read",
  "config.secrets",
  "graph.read",
  "graph.write",
  "engine.selfcheck",
  "transport.send",
  "transport.read",
  "transport.react",
  "telegram.send",
  "telegram.read",
  "telegram.react",
  "telegram.join",
  "telegram.leave",
  "telegram.forward",
  "llm.synthesize",
  "llm.summarize",
  "dispatch",
  "query",
]);
export type SkillCapability = z.infer<typeof CapabilitySchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Action Schema (один пакет может экспортировать несколько действий)
// ═══════════════════════════════════════════════════════════════════════════

export const ActionSchema = z.object({
  name: z.string(),
  category: z.string().default("app"),
  description: z.array(z.string()).min(1),
  usageHint: z.string().optional(),
  whenToUse: z.string(),
  whenNotToUse: z.string().optional(),
  params: z.array(ManifestParamSchema).default([]),
  returns: z.string().optional(),
  examples: z.array(z.string()).optional(),
  /** Переопределяет runtime уровня пакета (редкость — большинство пакетов имеют один backend). */
  runtime: RuntimeSchema.optional(),
});

export type ManifestAction = z.infer<typeof ActionSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Manifest Schema (верхний уровень)
// ═══════════════════════════════════════════════════════════════════════════

export const ManifestSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, "名称只允许小写字母、数字和连字符"),
  version: z.string(),
  author: z.string().optional(),
  license: z.string().optional(),
  description: z.string(),
  actions: z.array(ActionSchema).min(1),
  runtime: RuntimeSchema.optional(),
  family: FamilySchema.optional(),
  /** Ключ category, используемый при регистрации в CAPABILITY_FAMILIES (по умолчанию = manifest.name).
   *  Несколько Skill могут разделять один familyCategory (например, hitokoto/luck/fabing/kfc разделяют "fun"). */
  familyCategory: z.string().optional(),
  capabilities: z.array(CapabilitySchema).default([]),
  /** Полный текст справки (plain text). Если задан — используется приоритетно, иначе генерируется из manifest. */
  manPage: z.string().optional(),
});

export type SkillManifest = z.infer<typeof ManifestSchema>;
