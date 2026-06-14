/**
 * Dispatcher инструкций — портировано из narrative-engine core/dispatcher.ts.
 *
 * Основные обязанности:
 * 1. dispatch(instruction, args) — найти владеющий Mod → выполнить → разослать всем listener
 * 2. query(name, args) — найти владеющий Mod → выполнить (без рассылки)
 * 3. управление жизненным циклом tick (startTick / endTick)
 * 4. collectContributions — собрать результаты contribute всех Mod
 *
 * Ссылка: narrative-engine/core/dispatcher.ts
 */
import { getDb, getSqlite } from "../db/connection.js";
import { modStates as modStatesTable } from "../db/schema.js";
import type { WorldModel } from "../graph/world-model.js";
import { createLogger } from "../utils/logger.js";
import { generateShellManual } from "./shell-manual.js";
import type {
  ContributionItem,
  InstructionDefinition,
  ModContext,
  ModDefinition,
  ParamDefinition,
  QueryDefinition,
} from "./types.js";

const log = createLogger("dispatcher");

/**
 * ADR-79 M3: Глубокое слияние состояния Mod — initialState предоставляет значения по умолчанию для новых полей, persisted перекрывает существующие поля.
 *
 * Правила:
 * - оба значения — plain object → рекурсивное слияние
 * - массивы → приоритет persisted (элементы массива не сливаются)
 * - остальное → persisted перекрывает initial
 * - ключ отсутствует в persisted → сохраняется значение по умолчанию из initial
 */
export function deepMergeModState(initial: unknown, persisted: unknown): unknown {
  if (!isPlainObject(initial) || !isPlainObject(persisted)) {
    return persisted;
  }
  const merged: Record<string, unknown> = {};
  // Получаем все ключи по умолчанию из initial
  for (const key of Object.keys(initial)) {
    if (key in persisted) {
      const initVal = initial[key];
      const persVal = persisted[key];
      if (isPlainObject(initVal) && isPlainObject(persVal)) {
        merged[key] = deepMergeModState(initVal, persVal);
      } else {
        merged[key] = persVal;
      }
    } else {
      // отсутствует в persisted → сохраняем значение по умолчанию из initial (миграция нового поля)
      merged[key] = structuredClone(initial[key]);
    }
  }
  // ключи, присутствующие в persisted, но отсутствующие в initial, тоже сохраняются (прямая совместимость)
  for (const key of Object.keys(persisted)) {
    if (!(key in initial)) {
      merged[key] = structuredClone(persisted[key]);
    }
  }
  return merged;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// -- Интерфейс Dispatcher ----------------------------------------------------------

export interface Dispatcher {
  /** Выполнить записывающую инструкцию → разослать. */
  dispatch: (instruction: string, args: Record<string, unknown>) => unknown;
  /** Выполнить запрос только на чтение. */
  query: (name: string, args: Record<string, unknown>) => unknown;
  /** Все зарегистрированные имена инструкций. */
  getInstructionNames: () => string[];
  /** Получить определение инструкции (используется в общем цикле инъекций sandbox). */
  getInstructionDef: (name: string) => InstructionDefinition | undefined;
  /** Все зарегистрированные имена запросов. */
  getQueryNames: () => string[];
  /** Получить определение запроса (используется в pipeline инъекций запросов sandbox). */
  getQueryDef: (name: string) => QueryDefinition | undefined;
  /** Начало tick. ADR-110: поток nowMs — время внутри одного tick согласовано. При отсутствии — fallback к Date.now(). */
  startTick: (tick: number, nowMs?: number) => void;
  /** Конец tick. */
  endTick: (tick: number) => void;
  /** Собрать результаты contribute всех Mod. */
  collectContributions: () => ContributionItem[];
  /** Сгенерировать читаемый LLM справочник объявленных действий. */
  generateManual: () => Promise<string>;
  /** Список зарегистрированных Mod. */
  readonly mods: readonly ModDefinition[];
  /** ADR-31: Снимок состояния всех Mod (глубокая копия). */
  snapshotModStates: () => Map<string, unknown>;
  /** ADR-31: Восстановить состояние всех Mod из снимка. */
  restoreModStates: (snapshot: Map<string, unknown>) => void;
  /** ADR-33: Сохранить состояние всех Mod в DB. */
  saveModStatesToDb: (tick: number) => void;
  /** ADR-33: Восстановить состояние Mod из DB (вызывается при запуске). Возвращает, были ли восстановлены данные. */
  loadModStatesFromDb: () => boolean;
  /** Доступ к состоянию Mod только для чтения (для предварительного сбора в pipeline prompt). */
  readModState: <T = unknown>(name: string) => T | undefined;
}

// -- Создание Dispatcher ----------------------------------------------------------

export interface CreateDispatcherOptions {
  graph: WorldModel;
  mods: ModDefinition[];
  targetWhitelist?: ReadonlySet<string> | null;
}

export function createAliceDispatcher(options: CreateDispatcherOptions): Dispatcher {
  const { graph, mods, targetWhitelist = null } = options;

  // Хранилище состояния per-mod
  const modStates = new Map<string, unknown>();
  let currentTick = 0;
  /** ADR-110: Время стенных часов текущего tick (мс), устанавливается в startTick. */
  let currentNowMs = Date.now();
  let dispatchDepth = 0;
  const MAX_DISPATCH_DEPTH = 10;

  // Инициализация состояния
  for (const mod of mods) {
    modStates.set(mod.meta.name, structuredClone(mod.initialState));
  }

  // Создаём ModContext (ссылка на dispatch назначается ниже, замыкание безопасно)
  let dispatchFn: (instruction: string, args: Record<string, unknown>) => unknown;
  function ctx(modName: string): ModContext {
    // Прямая ссылка на state (изменения во внутренних dispatch видны внешним).
    // Откат при ошибке гарантируется механизмом snapshot-restore в dispatch() (см. исправление C3).
    return {
      graph,
      state: modStates.get(modName),
      tick: currentTick,
      nowMs: currentNowMs,
      targetWhitelist,
      getModState: <T = unknown>(name: string) => modStates.get(name) as T | undefined,
      dispatch: (instruction, args) => dispatchFn(instruction, args),
    };
  }

  // Запись состояния обратно
  function commitState(modName: string, c: ModContext) {
    modStates.set(modName, c.state);
  }

  /** C3: Снимок state для отката при ошибке. Глубокое копирование только для типа object. */
  function snapshotState(modName: string): unknown {
    const s = modStates.get(modName);
    return typeof s === "object" && s !== null ? structuredClone(s) : s;
  }

  // ADR-70 P3: Zod-валидация во время выполнения — проверяет параметры LLM перед выполнением инструкции/запроса.
  // Возвращает null = успех, иначе строку с описанием ошибки.
  // При успехе safeParse перезаписывает args значением parsed.data, чтобы Zod transforms (.trim()/.default())
  // применялись прозрачно для impl. impl больше не нужно повторно делать .trim() или ?? для значений по умолчанию.
  function validateParams(
    paramDefs: Record<string, ParamDefinition>,
    args: Record<string, unknown>,
  ): string | null {
    const errors: string[] = [];
    for (const [pName, pDef] of Object.entries(paramDefs)) {
      const parsed = pDef.schema.safeParse(args[pName]);
      if (!parsed.success) {
        errors.push(`${pName}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
      } else {
        args[pName] = parsed.data;
      }
    }
    return errors.length > 0 ? `Invalid params: ${errors.join("; ")}` : null;
  }

  function prepareArgs(
    def: InstructionDefinition | QueryDefinition,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const prepared = { ...args };
    const rawContextVars = prepared.__contextVars;
    delete prepared.__contextVars;

    if (!def.deriveParams || !isPlainObject(rawContextVars)) return prepared;

    for (const [paramName, derive] of Object.entries(def.deriveParams)) {
      if (prepared[paramName] != null) continue;
      const derived = derive(rawContextVars, prepared);
      if (derived != null) prepared[paramName] = derived;
    }

    return prepared;
  }

  // Индекс инструкция → Mod
  const instructionIndex = new Map<string, { mod: ModDefinition; def: InstructionDefinition }>();
  for (const mod of mods) {
    for (const [name, def] of Object.entries(mod.instructions ?? {})) {
      if (instructionIndex.has(name)) {
        log.warn(`Instruction ${name} duplicated, last-write-wins: ${mod.meta.name}`);
      }
      instructionIndex.set(name, { mod, def });
    }
  }

  // Индекс запрос → Mod
  const queryIndex = new Map<string, { mod: ModDefinition; def: QueryDefinition }>();
  for (const mod of mods) {
    for (const [name, def] of Object.entries(mod.queries ?? {})) {
      queryIndex.set(name, { mod, def });
    }
  }

  const dispatcher: Dispatcher = {
    mods,

    dispatch(instruction: string, args: Record<string, unknown>): unknown {
      const entry = instructionIndex.get(instruction);
      if (!entry) {
        log.warn(`Unknown instruction: ${instruction}`);
        return undefined;
      }

      // Защита от циклов: предотвращает переполнение стека из-за рекурсивных dispatch в listener
      if (dispatchDepth >= MAX_DISPATCH_DEPTH) {
        log.error(`Dispatch depth exceeded ${MAX_DISPATCH_DEPTH}`, { instruction });
        return undefined;
      }

      dispatchDepth++;
      try {
        // ADR-70 P3: Zod-валидация во время выполнения
        const preparedArgs = prepareArgs(entry.def, args);
        const validationError = validateParams(entry.def.params, preparedArgs);
        if (validationError) {
          return { success: false, error: validationError };
        }

        // 1. Выполнение
        // C3: снимок до выполнения — при ошибке восстанавливаем состояние до выполнения,
        // чтобы исключить остаточные промежуточные состояния при изменении state через ссылку в impl с последующим исключением.
        const modName = entry.mod.meta.name;
        const stateBackup = snapshotState(modName);
        const c = ctx(modName);
        let result: unknown;
        try {
          result = entry.def.impl(c, preparedArgs);
          commitState(modName, c);
        } catch (e) {
          // Откат к состоянию до выполнения
          modStates.set(modName, stateBackup);
          log.error(`Instruction ${instruction} failed`, e);
          // H1: sentinel вместо undefined — иначе роут рапортует LLM «успех» и упавшее действие теряется.
          return { __dispatchError: e instanceof Error ? e.message : String(e) };
        }

        // 2. Рассылка всем listener
        for (const mod of mods) {
          const handler = mod.listen?.[instruction];
          if (handler) {
            try {
              const lc = ctx(mod.meta.name);
              handler(lc, preparedArgs, result);
              commitState(mod.meta.name, lc);
            } catch (e) {
              log.warn(`Listener ${mod.meta.name}.${instruction} failed`, e);
            }
          }
        }

        return result;
      } finally {
        dispatchDepth--;
      }
    },

    query(name: string, args: Record<string, unknown>): unknown {
      const entry = queryIndex.get(name);
      if (!entry) {
        log.warn(`Unknown query: ${name}`);
        return undefined;
      }
      // ADR-70 P3: Zod-валидация во время выполнения
      const preparedArgs = prepareArgs(entry.def, args);
      const validationError = validateParams(entry.def.params, preparedArgs);
      if (validationError) {
        return { success: false, error: validationError };
      }
      const c = ctx(entry.mod.meta.name);
      try {
        return entry.def.impl(c, preparedArgs);
      } catch (e) {
        log.error(`Query ${name} failed`, e);
        // H1: sentinel вместо undefined — чтобы роут не выдал «успех» при упавшем query.
        return { __dispatchError: e instanceof Error ? e.message : String(e) };
      }
    },

    getInstructionNames: () => [...instructionIndex.keys()],
    getInstructionDef: (name: string) => instructionIndex.get(name)?.def,
    getQueryNames: () => [...queryIndex.keys()],
    getQueryDef: (name: string) => queryIndex.get(name)?.def,

    async generateManual(): Promise<string> {
      return generateShellManual(mods);
    },

    startTick(tick: number, nowMs: number = Date.now()) {
      currentTick = tick;
      currentNowMs = nowMs;
      for (const mod of mods) {
        if (mod.onTickStart) {
          const c = ctx(mod.meta.name);
          try {
            mod.onTickStart(c);
            commitState(mod.meta.name, c);
          } catch (e) {
            log.warn(`${mod.meta.name}.onTickStart failed`, e);
          }
        }
      }
    },

    endTick(tick: number) {
      currentTick = tick;
      for (const mod of mods) {
        if (mod.onTickEnd) {
          const c = ctx(mod.meta.name);
          try {
            mod.onTickEnd(c);
            commitState(mod.meta.name, c);
          } catch (e) {
            log.warn(`${mod.meta.name}.onTickEnd failed`, e);
          }
        }
      }
    },

    collectContributions(): ContributionItem[] {
      const items: ContributionItem[] = [];
      for (const mod of mods) {
        if (mod.contribute) {
          const c = ctx(mod.meta.name);
          try {
            items.push(...mod.contribute(c));
          } catch (e) {
            log.warn(`${mod.meta.name}.contribute failed`, e);
          }
        }
      }
      return items;
    },

    // ADR-31: Снимок/восстановление состояния Mod (для атомарного выполнения в sandbox)
    // ⚠ Допущение об атомарном откате: побочные эффекты всех listener ограничены свойствами графа и состоянием Mod.
    // Граф откатывается через restoreFrom(graphSnapshot), Mod — через restoreModStates(modSnapshot).
    // Если в будущем listener будет производить побочные эффекты за пределами графа/Mod (например, прямая запись в DB), откат будет неполным.
    snapshotModStates(): Map<string, unknown> {
      const snapshot = new Map<string, unknown>();
      for (const [name, state] of modStates) {
        snapshot.set(name, structuredClone(state));
      }
      return snapshot;
    },

    restoreModStates(snapshot: Map<string, unknown>): void {
      for (const [name, state] of snapshot) {
        // ADR-79 M3: при восстановлении тоже выполняем глубокое слияние, чтобы в снимке не отсутствовали новые поля
        const mod = mods.find((m) => m.meta.name === name);
        const merged = mod
          ? deepMergeModState(mod.initialState, structuredClone(state))
          : structuredClone(state);
        modStates.set(name, merged);
      }
    },

    // ADR-33 Phase 1: Сохранение состояния Mod
    // Исправление P1-core-1: оборачиваем в транзакцию для защиты от частичных записей + снижение накладных расходов WAL sync.
    saveModStatesToDb(tick: number): void {
      const db = getDb();
      const sqlite = getSqlite();
      const txn = sqlite.transaction(() => {
        for (const [name, state] of modStates) {
          try {
            const json = JSON.stringify(state);
            db.insert(modStatesTable)
              .values({
                modName: name,
                stateJson: json,
                updatedTick: tick,
              })
              .onConflictDoUpdate({
                target: modStatesTable.modName,
                set: {
                  stateJson: json,
                  updatedTick: tick,
                  updatedAt: new Date(),
                },
              })
              .run();
          } catch (e) {
            log.warn(`Failed to save mod state: ${name}`, e);
          }
        }
      });
      try {
        txn();
        log.debug("Mod states saved to DB", { tick, count: modStates.size });
      } catch (e) {
        log.error("Failed to save mod states (transaction rolled back)", e);
      }
    },

    loadModStatesFromDb(): boolean {
      const db = getDb();
      const rows = db.select().from(modStatesTable).all();
      if (rows.length === 0) return false;

      // ADR-79 M3: строим индекс modName → initialState (для глубокого слияния)
      const initialStates = new Map<string, unknown>();
      for (const mod of mods) {
        initialStates.set(mod.meta.name, mod.initialState);
      }

      let restored = 0;
      for (const row of rows) {
        if (modStates.has(row.modName)) {
          try {
            const persisted = JSON.parse(row.stateJson);
            const initial = initialStates.get(row.modName);
            // ADR-79 M3: глубокое слияние — initialState предоставляет значения по умолчанию для новых полей
            const merged = deepMergeModState(initial, persisted);
            modStates.set(row.modName, merged);
            restored++;
          } catch (e) {
            log.warn(`Failed to parse mod state: ${row.modName}`, e);
          }
        }
      }
      log.info("Mod states restored from DB", { restored, total: rows.length });
      return restored > 0;
    },

    readModState<T = unknown>(name: string): T | undefined {
      return modStates.get(name) as T | undefined;
    },
  };

  // Назначаем dispatchFn для использования в ModContext.dispatch (ссылка замыкания)
  dispatchFn = dispatcher.dispatch;

  return dispatcher;
}
