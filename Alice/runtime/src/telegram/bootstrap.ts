/**
 * Первый запуск: iterDialogs + getContacts → начальный граф.
 *
 * Получает список диалогов и контакты из Telegram, строит начальную WorldModel.
 */
import type { TelegramClient } from "@mtcute/node";
import { Chat, User } from "@mtcute/node";
import { telegramChannelId, telegramContactId } from "../graph/constants.js";
import type { ChatType, DunbarTier } from "../graph/entities.js";
import { WorldModel } from "../graph/world-model.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("bootstrap");

/**
 * Строит начальный граф из Telegram.
 *
 * Шаги:
 * 1. Получаем собственные данные → узел AGENT
 * 2. iterDialogs → узлы CHANNEL
 * 3. Для собеседников/участников в личных чатах и малых группах → узлы CONTACT + рёбра
 */
export async function buildInitialGraph(client: TelegramClient): Promise<WorldModel> {
  const G = new WorldModel();
  G.tick = 0;

  // 1. Собственный узел
  const self = await client.getMe();
  const selfId = `self`;
  G.addAgent(selfId);
  log.info("Agent node created", { userId: self.id });

  // 2. Перебираем диалоги
  let dialogCount = 0;
  for await (const dialog of client.iterDialogs()) {
    const peer = dialog.peer;

    // Пропускаем Saved Messages (self-chat) — Алиса не должна писать самой себе
    if (peer instanceof User && peer.id === self.id) continue;

    const chatId = String(peer.id);
    const channelId = telegramChannelId(chatId);

    // Определяем тип peer: User — личный чат, Chat — группа/канал
    const isUser = peer instanceof User;
    const isChat = peer instanceof Chat;

    let chatType: ChatType;
    if (isUser) {
      chatType = "private";
    } else if (isChat) {
      const ct = peer.chatType;
      if (ct === "channel") chatType = "channel";
      else if (ct === "supergroup") chatType = "supergroup";
      else chatType = "group";
    } else {
      chatType = "group";
    }

    // ADR-206: каналы больше не пропускаются, входят в мировую модель как самостоятельные сущности
    // Предполагаемый tier: личный чат → 50, группа → 150, канал → 500 (низкоприоритетный источник)
    const tierContact: DunbarTier =
      chatType === "private" ? 50 : chatType === "channel" ? 500 : 150;

    // ADR-206 W7: определяем alice_role из объекта Chat (без затрат на API)
    let aliceRole: string | undefined;
    if (isChat) {
      if (peer.isCreator) aliceRole = "owner";
      else if (peer.isAdmin) aliceRole = "admin";
    }

    // ADR-220: записываем display_name (для групп/каналов используем title, для личных чатов — displayName)
    const channelDisplayName = isChat ? peer.title : isUser ? peer.displayName : undefined;

    G.addChannel(channelId, {
      chat_type: chatType,
      tier_contact: tierContact,
      unread: dialog.unreadCount ?? 0,
      display_name: channelDisplayName,
      ...(aliceRole ? { alice_role: aliceRole } : {}),
    });

    // self monitors канал
    G.addRelation(selfId, "monitors", channelId);

    // Личный чат → создаём узел CONTACT
    if (isUser) {
      const contactId = telegramContactId(chatId);
      if (!G.has(contactId)) {
        G.addContact(contactId, {
          tier: tierContact,
          display_name: peer.displayName ?? `user_${chatId}`,
          ...(peer.isBot ? { is_bot: true } : {}),
        });
        G.addRelation(selfId, "acquaintance", contactId);
        G.addRelation(contactId, "joined", channelId);
      }
    }

    dialogCount++;
    if (dialogCount >= 200) break;
  }

  log.info("Initial graph built", { dialogCount, nodes: G.size, edges: G.edgeCount });
  return G;
}
