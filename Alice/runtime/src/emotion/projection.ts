import type { ActiveEmotion, EmotionState } from "./types.js";

function fadingSuffix(emotion: ActiveEmotion): string {
  return emotion.ageMs > emotion.halfLifeMs ? ", но уже потихоньку отпускает" : "";
}

function renderEmotionLine(emotion: ActiveEmotion): string {
  switch (emotion.kind) {
    case "pleased":
      return "От той фразы стало радостно. Самую малость.";
    case "touched":
      return "Те слова такие тёплые. До сих пор греют.";
    case "shy":
      return "Меня раскусили… как-то неловко теперь.";
    case "lonely":
      return "Что-то соскучилась по нему. Не то чтобы что-то нужно… просто вдруг подумалось.";
    case "hurt":
      return `Та фраза всё ещё колет где-то внутри${fadingSuffix(emotion)}. Хочется спросить, но боюсь, что спрошу — и выйдет ещё глупее.`;
    case "uneasy":
      return "Та фраза всё крутится в голове. Наверное, ничего страшного… но не уверена.";
    case "annoyed":
      return "Та фраза. Немного задело. …Ладно, проехали.";
    case "tired":
      return "Так устала. Это не игнор… просто слов стало меньше.";
    case "flat":
      return "Всё какое-то тусклое. Как будто сквозь какую-то пелену.";
  }
}

export function renderEmotionProjection(state: EmotionState): string | null {
  if (!state.dominant) return null;
  const lines = [renderEmotionLine(state.dominant)];
  if (state.secondary) {
    lines.push(renderEmotionLine(state.secondary));
  }
  return lines.join("\n");
}

export function renderEmotionDebugSummary(state: EmotionState): string {
  const parts = [state.dominant, state.secondary]
    .filter((emotion): emotion is ActiveEmotion => emotion != null)
    .map((emotion) => `${emotion.kind} ${emotion.effectiveIntensity.toFixed(2)}`);
  return parts.length > 0 ? parts.join(" + ") : "none";
}
