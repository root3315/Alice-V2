import type { ToolCategory } from "../engine/tick/types.js";

export interface CapabilityFamily {
  /** shell manual / legacy category summary 中显示的「何时使用」描述 */
  whenToUse: string;
  /** Activated Tools 段头部的简短描述 */
  label: string;
  /** 展开态教程示例 */
  tutorials?: readonly string[];
}

/**
 * Category-level metadata for capability families (discoverable via `<command> --help`).
 * @see docs/adr/216-cli-help-unification.md
 */
export const CAPABILITY_FAMILIES: Partial<Record<ToolCategory, CapabilityFamily>> = {
  mood: {
    whenToUse: "Глубокий анализ эмоций и обратная связь",
    label: "Восприятие обстановки и состояния",
    tutorials: [
      "# self --help -> rate-outcome, flag-risk...",
      'self rate-outcome --target self --action_ms 1777550000000 --quality good --reason "она улыбнулась"',
    ],
  },
  social: {
    whenToUse: "Управление профилями отношений",
    label: "Понимание людей",
    tutorials: [
      "# self --help -> note-active-hour, tag-interest...",
      "self note-active-hour --contactId @1000000001 --hour 14",
    ],
  },
  threads: {
    whenToUse: "Управление жизненным циклом тредов",
    label: "Управление тредами",
    tutorials: [
      "# self --help -> intend, resolve-topic...",
      'self intend --description "при следующей встрече спросить, чем всё закончилось" --priority minor',
    ],
  },
  memory: {
    whenToUse: "Хранение знаний и размышления",
    label: "Сохранение знаний",
    tutorials: [
      "# self --help -> diary, recall-fact...",
      'self diary --content "сегодня много болтали, кажется, мы стали ближе"',
    ],
  },
  scheduler: {
    whenToUse: "Планирование задач",
    label: "Планирование задач",
    tutorials: [
      "# self --help -> schedule-task, cancel-task...",
      'self schedule-task --type at --delay 5 --action "remind about meeting"',
    ],
  },
  skills: {
    whenToUse:
      "Discover and install new capabilities - search the Skill Store when you need a tool you don't have",
    label: "Управление навыками (Skill)",
    tutorials: [
      'alice-pkg search "погода"   # поиск доступных Skill',
      "alice-pkg search            # список всех Skill",
      "alice-pkg install weather   # установить нужный Skill",
      "alice-pkg list              # посмотреть установленные Skill",
      "alice-pkg info weather      # подробности о Skill",
    ],
  },
  chat_history: {
    whenToUse: "Поиск по истории чатов / дневнику / тредам",
    label: "Поиск по истории чатов",
    tutorials: [
      "irc tail --count 10",
      "irc whois",
      "irc threads",
      "# results appear in command output or the next round",
    ],
  },
  contact_info: {
    whenToUse: "Взаимодействие с ботами / поиск контактов",
    label: "Контакты и боты",
    tutorials: ["irc whois --target @1000000001", "irc whois"],
  },
  sticker: {
    whenToUse: "Просмотр и управление наборами стикеров",
    label: "Стикеры",
    tutorials: ["irc sticker --keyword happy", "irc sticker --help"],
  },
  media: {
    whenToUse: "Отправка картинок / файлов / медиа",
    label: "Медиа",
    tutorials: [
      'irc send-file --path ./file.png --caption "смотри, что покажу"',
      "# download + process + send-file: irc download -> convert -> irc send-file",
    ],
  },
  group_admin: {
    whenToUse: "Поиск, вступление и управление группами",
    label: "Управление группами",
    tutorials: ['irc join --target "@channel_name"', "irc leave"],
  },
};

export function registerCapabilityFamily(category: string, family: CapabilityFamily): void {
  (CAPABILITY_FAMILIES as Record<string, CapabilityFamily>)[category] = family;
}

export function unregisterCapabilityFamily(category: string): void {
  delete (CAPABILITY_FAMILIES as Record<string, CapabilityFamily>)[category];
}
