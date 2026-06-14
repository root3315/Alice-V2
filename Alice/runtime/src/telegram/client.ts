/**
 * Инициализация Telegram-клиента mtcute.
 */

import { Dispatcher } from "@mtcute/dispatcher";
import { TelegramClient } from "@mtcute/node";
import type { Config } from "../config.js";

let _client: TelegramClient | null = null;
let _dispatcher: Dispatcher | null = null;

/**
 * Создаёт и возвращает экземпляр TelegramClient.
 * Файл сессии по умолчанию хранится как SQLite (встроено в mtcute).
 */
export function createClient(config: Config): TelegramClient {
  if (_client) return _client;

  _client = new TelegramClient({
    apiId: config.telegramApiId,
    apiHash: config.telegramApiHash,
    storage: "alice.session",
    // mtcute по умолчанию регистрирует exit hook для SIGINT/SIGTERM, что конкурирует
    // с асинхронным shutdown Алисы при закрытии session DB. Единый вызов destroyClient() — в runtime/src/index.ts.
    storageOptions: { cleanup: false },
  });

  return _client;
}

/**
 * Возвращает текущий экземпляр client (необходимо предварительно вызвать createClient).
 */
export function getClient(): TelegramClient {
  if (!_client) throw new Error("TelegramClient not initialized. Call createClient() first.");
  return _client;
}

/**
 * Создаёт и привязывает Dispatcher к client.
 */
export function createDispatcher(client: TelegramClient): Dispatcher {
  if (_dispatcher) return _dispatcher;
  _dispatcher = Dispatcher.for(client);
  return _dispatcher;
}

/**
 * Возвращает текущий экземпляр Dispatcher.
 */
export function getDispatcher(): Dispatcher {
  if (!_dispatcher) throw new Error("Dispatcher not initialized. Call createDispatcher() first.");
  return _dispatcher;
}

/**
 * Запускает клиент (вход / восстановление сессии).
 */
export async function startClient(client: TelegramClient, phone: string): Promise<void> {
  await client.start({
    phone: () => Promise.resolve(phone),
    code: () => client.input("Enter the code: "),
    password: () => client.input("Enter 2FA password: "),
  });
}

/**
 * Корректное завершение работы.
 * try/catch: при shutdown не стоит блокировать выход из-за ошибки очистки client.
 */
export async function destroyClient(): Promise<void> {
  try {
    if (_dispatcher) {
      _dispatcher.unbind();
      await _dispatcher.destroy();
      _dispatcher = null;
    }
  } catch {
    /* shutdown — тихо */
  }
  try {
    if (_client) {
      await _client.destroy();
      _client = null;
    }
  } catch {
    /* shutdown — тихо */
  }
}
