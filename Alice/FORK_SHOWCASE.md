# Project Aura (Alice Enhanced) — Fork Showcase & Architecture Report

> **Based on [LlmKira/Alice](https://github.com/LlmKira/Alice)**  
> **Author of Enhancements:** sozda (`sozdayvek@gmail.com`)  
> **Commit History:** 138+ production commits over active real-world deployment.  
> **Hardware Extension:** Physical desktop companion robot (ESP32-S3 + Camera + Eye Animation).

---

## 🇨🇳 致原作者 (To LlmKira / Diana)

你好！非常感谢你开源了 Alice 这个令人惊叹的数字生命架构。你的 **Narrative Physics（叙事物理学）** 和 **六维压力场（P1–P6）** 是我们在开源社区见过的最生动、最具生命力的 Agent 核心。

我们在真实长期部署和实机交互中，对 Alice 进行了深度的工程化重构、重大 Bug 修复以及新特性的扩展（共计 138 个独立 commit）。

为了方便你了解这些改进，我们将所有优化整理如下。如果你对其中的任何模块或 Bug 修复感兴趣，我们非常乐意将这些特性 PR 回原仓库！

---

## 1. 🐛 Critical Bug Fixes (重大核心修复)

| 模块 | 问题 (原版) | 修复方案 (我们的增强版) |
|---|---|---|
| **Autonomous Exploration** | **P4 / Busy-gate 永久死锁**: 原始代码要求 `API <= 0.5` 才能触发探索，但在多群聊环境下 baseline 压力通常为 ~1.5，导致自主探索机制 **24小时+ 永远无法触发**。 | 将 `PRESSURE_GATE` 默认阈值提升至 3.0，并增加了自主探索冷启动 baseline 计时器修复。探索机制成功激活并在真实环境中自主搜索与订阅频道。 |
| **Cross-Chat Isolation** | **跨群聊上下文串台**: 在多群并发时，偶发将其他聊天室的上下文带入当前对话，导致“向错误的群回复了别处的话”。 | 增加了严格的跨聊天隔离边界 (`isolate cross-chat reads`)，防止注意力机制在群聊间泄露。 |
| **Relationship Decay** | **正常结束对话被误判为惩罚**: 对方正常结束对话（Saying goodbye）被系统记录为 `-0.4` 的负反馈，导致长期交流反而好感度下降。 | 将会话自然终止修复为中性反馈 (Neutral)，并为高亲密度关系设立了信任保底 (`trust-floor`)。 |
| **Startup Resilience** | **冷启动超时崩溃**: 在本地大模型或代理首次启动延迟较高时，15秒健康检查直接抛出 Fatal Exception 崩溃进程。 | 将检查超时放宽至 45秒，并将初次网络探测改造为 non-fatal，支持异步重试与半开恢复。 |
| **Sticker Ping-Pong** | **自发连续表情包轰炸**: 当表情包未得到回复时可能连续追加。 | 增加了严格的 anti-repetition 防重复机制与 `no back-to-back stickers` 约束。 |
| **HTTP Timeout** | **长耗时请求断流**: Undici 默认 300s 请求头超时导致长时间代码审查中断。 | 重构为 `node:http` 长连接穿透，彻底解决断流。 |

---

## 2. 🚀 Major Feature Innovations (全新功能特性)

### 🎙️ 1. Human-Like Conversation Rhythm (拟人化对话节奏)
* **Typing-Aware Settle:** Алиса теперь следит за статусом «печатает...» собеседника в реальном времени. Если человек ещё дописывает мысль, она держит паузу и не перебивает.
* **Burst-Settle Debounce:** Если пользователь отправляет мысль несколькими короткими сообщениями подряд, система дебаунсит входящие события и объединяет их в единый смысловой блок.
* **Anti-Repetition Buffer:** Добавлен постоянно видимый per-chat буфер недавних собственных фраз, исключающий эффект «заевшей пластинки».

### 🏷️ 2. Smart Unicode Name Detection (Интеллектуальная детекция обращения)
* В оригинале бот реагировал только на явный `@username` или reply.
* Мы добавили полнотекстовую детекцию имени (с учётом падежей, границ слов и Unicode-символов: *Аура, Ауру, Ауре, Аурой, Aura*).
* При прямом обращении по имени в группе активируется приоритетный soul-контрибьют (priority 96), гарантирующий реакцию без неуместного ухода в молчание.

### 🧠 3. Continuity of Self & Memory (Долговременная личность и память)
* **Periodic Self-Reflection:** Модуль регулярной автобиографической рефлексии (ежедневные и еженедельные записи для формирования целостного самосознания).
* **Commitment Follow-Through:** Трекинг обещаний собеседника («я пришлю тебе ссылку завтра») с мягким контекстным напоминанием.
* **Semantic Recall:** Интеграция локального векторного поиска через Text Embeddings Inference (`multilingual-e5-small`) для ассоциативного извлечения воспоминаний.

### 📱 4. Telegram Rich Interactions (mtcute 0.30 Integration)
* Обновление MTProto-клиента до **mtcute 0.30.1** (Layer 227).
* Добавлена отправка нативных кликабельных интерактивных чеклистов (`send_checklist`) и форматированных таблиц (`send_table`).
* Реализовано участие в голосованиях Telegram (`irc vote`) и создание собственных опросов.

### 🖼️ 5. VLM Sticker Understanding & Indexing
* Индексация стикерпаков через Vision Language Model (VLM): каждый стикер размечается по эмоциональному тону и сюжету.
* Выбор стикера происходит осознанно по смыслу эмоции, а не случайно по ключевым словам.

---

## 3. 🤖 Physical Hardware Companion (`alice-board`)

Помимо программного агента, мы разработали **физическое настольное воплощение**:
* **Микроконтроллер:** ESP32-S3 с PSRAM и камерой OV2640/OV5640.
* **Динамический взгляд (`eye-live.py`):** процедурная анимация взгляда на экране, отслеживающая движения и выражающая эмоции агента.
* **Слух и голос (Локальный контур):**
  * **Faster-Whisper (large-v3)** на CUDA int8_float16 (распознавание речи за 3 секунды);
  * **XTTS-v2 клон** с VRAM-оптимизацией под 8 ГБ видеопамяти.

---

## 4. 📊 Summary Statistics (Сводная статистика)

```text
- Total Custom Commits: 138+
- Active Runtime Uptime: сотни часов непрерывной автономной работы
- Decisions Logged: > 2,600 действий, > 19,000 квантованных решений молчания (silence)
- Core Language: Полная русификация всех когнитивных модулей и памяти
- Target Platform: Telegram MTProto + Local Audio Shims + ESP32 Hardware
```
