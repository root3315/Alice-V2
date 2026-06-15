/**
 * Инъекция конфигурации семантического recall (ADDITIVE, OFF BY DEFAULT).
 *
 * recall.mod не имеет доступа к глобальному Config через ctx, поэтому адрес/модель
 * локального сервера эмбеддингов передаётся сюда один раз при старте (index.ts).
 *
 * ПО УМОЛЧАНИЮ ОТКЛЮЧЕНО: пока никто не вызвал setEmbeddingConfig() с непустым
 * base_url/model, getEmbeddingConfig() возвращает «выключенный» конфиг и весь
 * семантический путь recall молча пропускается → поведение recall байт-в-байт как
 * раньше. Это же гарантирует, что юнит-тесты recall без явной настройки идут по
 * keyword-пути.
 *
 * @see embeddings.ts — isEmbeddingEnabled() читает эти поля
 * @see recall.mod.ts — единственный потребитель
 */
import type { EmbeddingConfig } from "./embeddings.js";

const DISABLED: EmbeddingConfig = {
  embeddingBaseUrl: "",
  embeddingApiKey: "",
  embeddingModel: "",
};

let _config: EmbeddingConfig = DISABLED;

/** Установить конфиг эмбеддингов (вызывается из index.ts при старте). */
export function setEmbeddingConfig(config: EmbeddingConfig): void {
  _config = {
    embeddingBaseUrl: config.embeddingBaseUrl ?? "",
    embeddingApiKey: config.embeddingApiKey ?? "",
    embeddingModel: config.embeddingModel ?? "",
  };
}

/** Текущий конфиг эмбеддингов (по умолчанию — выключенный). */
export function getEmbeddingConfig(): EmbeddingConfig {
  return _config;
}

/** Сброс к выключенному состоянию (для тестов). */
export function resetEmbeddingConfig(): void {
  _config = DISABLED;
}
