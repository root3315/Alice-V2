export type TransportTargetKind = "channel" | "contact";

declare const transportTargetStableIdBrand: unique symbol;
declare const transportMessageStableIdBrand: unique symbol;

export type TransportTargetStableId = string & {
  readonly [transportTargetStableIdBrand]: "TransportTargetStableId";
};

export type TransportMessageStableId = string & {
  readonly [transportMessageStableIdBrand]: "TransportMessageStableId";
};

export interface TransportTargetRef {
  kind: TransportTargetKind;
  platform: string;
  nativeId: string;
  stableId: string;
  legacy: boolean;
}

export type ParsedTransportTargetRef = TransportTargetRef & {
  readonly stableId: TransportTargetStableId;
};

export class TransportTargetId {
  private constructor(readonly ref: TransportTargetRef) {}

  static parse(value: unknown): TransportTargetId | null {
    const ref = parseTransportTargetId(value);
    return ref === null ? null : new TransportTargetId(ref);
  }

  static isChannel(value: unknown): boolean {
    return TransportTargetId.parse(value)?.isChannel ?? false;
  }

  get kind(): TransportTargetKind {
    return this.ref.kind;
  }

  get platform(): string {
    return this.ref.platform;
  }

  get nativeId(): string {
    return this.ref.nativeId;
  }

  get stableId(): string {
    return this.ref.stableId;
  }

  get isChannel(): boolean {
    return this.ref.kind === "channel";
  }
}

export interface TransportMessageRef {
  platform: string;
  chatNativeId: string;
  messageNativeId: string;
  stableId: string;
}

export type ParsedTransportMessageRef = TransportMessageRef & {
  readonly stableId: TransportMessageStableId;
};

export interface TransportSendParams {
  target: TransportTargetRef;
  text: string;
  replyTo?: TransportMessageRef;
}

export interface TransportSendResult {
  platform: string;
  target: string;
  messageId: string | null;
  nativeMessageId: string | number | null;
}

export interface TransportReadParams {
  target: TransportTargetRef;
}

export interface TransportReadResult {
  platform: string;
  target: string;
  ok: true;
}

export interface TransportReactParams {
  target: TransportTargetRef;
  message: TransportMessageRef;
  emoji: string;
}

export interface TransportReactResult {
  platform: string;
  target: string;
  message: string;
  ok: true;
}

export interface TransportAdapter {
  platform: string;
  send?: (params: TransportSendParams) => Promise<TransportSendResult>;
  read?: (params: TransportReadParams) => Promise<TransportReadResult>;
  react?: (params: TransportReactParams) => Promise<TransportReactResult>;
}

// Bridge protocols are adapter paths, not target platform namespaces.
// @see docs/adr/265-multi-im-platform-strategy/README.md
const TELEGRAM_NATIVE_ID_RE = /^-?\d+$/;
const RESERVED_BRIDGE_PROTOCOL_NAMES = new Set([
  "satori",
  "onebot",
  "koishi",
  "llonebot",
  "napcat",
  "aiocqhttp",
]);

export function isReservedBridgeProtocolName(value: string): boolean {
  return RESERVED_BRIDGE_PROTOCOL_NAMES.has(value.toLowerCase());
}

function isValidTransportPlatform(value: string): boolean {
  return value.length > 0 && !isReservedBridgeProtocolName(value);
}

function stableTransportTargetIdValue(
  kind: TransportTargetKind,
  platform: string,
  nativeId: string,
): TransportTargetStableId {
  return `${kind}:${platform.toLowerCase()}:${nativeId}` as TransportTargetStableId;
}

function normalizeStableTarget(
  kind: TransportTargetKind,
  platform: string,
  nativeId: string,
  legacy: boolean,
): ParsedTransportTargetRef {
  const normalizedPlatform = platform.toLowerCase();
  return {
    kind,
    platform: normalizedPlatform,
    nativeId,
    stableId: stableTransportTargetIdValue(kind, normalizedPlatform, nativeId),
    legacy,
  };
}

export function stableTransportTargetId(
  kind: TransportTargetKind,
  platform: string,
  nativeId: string | number,
): TransportTargetStableId {
  return stableTransportTargetIdValue(kind, platform, String(nativeId));
}

export function transportTargetRef(
  kind: TransportTargetKind,
  platform: string,
  nativeId: string | number,
): ParsedTransportTargetRef {
  return normalizeStableTarget(kind, platform, String(nativeId), false);
}

export function parseTransportTargetId(value: unknown): ParsedTransportTargetRef | null {
  if (typeof value !== "string" || value.length === 0) return null;

  const parts = value.split(":");
  if (
    parts.length === 3 &&
    (parts[0] === "channel" || parts[0] === "contact") &&
    isValidTransportPlatform(parts[1]) &&
    parts[2].length > 0
  ) {
    return normalizeStableTarget(parts[0], parts[1], parts[2], false);
  }

  return null;
}

export function isTransportChannelTarget(value: unknown): boolean {
  return TransportTargetId.isChannel(value);
}

export function parseTransportMessageId(value: unknown): ParsedTransportMessageRef | null {
  if (typeof value !== "string" || value.length === 0) return null;

  const parts = value.split(":");
  if (
    parts.length === 4 &&
    parts[0] === "message" &&
    isValidTransportPlatform(parts[1]) &&
    parts[2].length > 0 &&
    parts[3].length > 0
  ) {
    const platform = parts[1].toLowerCase();
    return {
      platform,
      chatNativeId: parts[2],
      messageNativeId: parts[3],
      stableId: stableTransportMessageId(platform, parts[2], parts[3]),
    };
  }

  return null;
}

export function stableTransportMessageId(
  platform: string,
  chatNativeId: string,
  messageNativeId: string | number,
): TransportMessageStableId {
  return `message:${platform.toLowerCase()}:${chatNativeId}:${messageNativeId}` as TransportMessageStableId;
}

export function transportMessageRef(
  platform: string,
  chatNativeId: string | number,
  messageNativeId: string | number,
): ParsedTransportMessageRef {
  const chatId = String(chatNativeId);
  const msgId = String(messageNativeId);
  return {
    platform: platform.toLowerCase(),
    chatNativeId: chatId,
    messageNativeId: msgId,
    stableId: stableTransportMessageId(platform, chatId, msgId),
  };
}

export function parseTelegramNativeId(value: string): number | null {
  if (!TELEGRAM_NATIVE_ID_RE.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function requireTelegramNativeId(value: string, label: string): number {
  const parsed = parseTelegramNativeId(value);
  if (parsed === null) throw new Error(`invalid Telegram ${label} native id`);
  return parsed;
}

export function createTelegramTransportAdapter(callbacks: {
  send?: (params: {
    chatId: number;
    text: string;
    replyTo?: number;
  }) => Promise<{ msgId: number | null }>;
  markRead?: (chatId: number) => Promise<{ ok: true }>;
  react?: (params: { chatId: number; msgId: number; emoji: string }) => Promise<{ ok: true }>;
}): TransportAdapter {
  const send = callbacks.send;
  const markRead = callbacks.markRead;
  const react = callbacks.react;
  return {
    platform: "telegram",
    send: send
      ? async ({ target, text, replyTo }) => {
          const chatId = requireTelegramNativeId(target.nativeId, "target");
          let replyToMsgId: number | undefined;
          if (replyTo) {
            if (replyTo.platform !== "telegram") {
              throw new Error("reply message ref platform does not match Telegram adapter");
            }
            const replyChatId = requireTelegramNativeId(replyTo.chatNativeId, "reply chat");
            if (replyChatId !== chatId)
              throw new Error("reply message ref does not belong to target");
            replyToMsgId = requireTelegramNativeId(replyTo.messageNativeId, "reply message");
          }
          const result = await send({ chatId, text, replyTo: replyToMsgId });
          return {
            platform: "telegram",
            target: target.stableId,
            messageId:
              result.msgId == null
                ? null
                : stableTransportMessageId("telegram", String(chatId), result.msgId),
            nativeMessageId: result.msgId,
          };
        }
      : undefined,
    read: markRead
      ? async ({ target }) => {
          const chatId = requireTelegramNativeId(target.nativeId, "target");
          await markRead(chatId);
          return { platform: "telegram", target: target.stableId, ok: true };
        }
      : undefined,
    react: react
      ? async ({ target, message, emoji }) => {
          const chatId = requireTelegramNativeId(target.nativeId, "target");
          if (message.platform !== "telegram") {
            throw new Error("message ref platform does not match Telegram adapter");
          }
          const messageChatId = requireTelegramNativeId(message.chatNativeId, "message chat");
          if (messageChatId !== chatId) throw new Error("message ref does not belong to target");
          const msgId = requireTelegramNativeId(message.messageNativeId, "message");
          await react({ chatId, msgId, emoji });
          return {
            platform: "telegram",
            target: target.stableId,
            message: message.stableId,
            ok: true,
          };
        }
      : undefined,
  };
}
