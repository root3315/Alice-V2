# Prompt Engineering Blind Review

> 审阅对象: `preview-prompt-output.md` (ADR-69 Prompt Preview)
> 场景: Carol（密友，tier 15）发了猫照片，Alice 当前声部 curiosity
> 审阅日期: 2026-02-16

---

## 1. 认知负荷 — 7/10

**同时追踪的上下文变量数量：~12 个**

LLM 需要在脑中同时维持以下变量：
- 自身身份（Alice）
- 当前情绪（neutral + curiosity 声部）
- 对话对象画像（Carol, close_friend, tier 15, 3 条 facts）
- 语言偏好（中文）
- 消息历史（3 条 live messages）
- TARGET_CHAT / CHAT_NAME 上下文变量
- self-notes（1 条）
- 6 个核心函数（think/reply/stay_silent/feel/remember/advance）
- ~30 个 Telegram 动作函数
- ~25 个 Dispatcher 指令
- ~20 个 Query 函数
- 可用 capabilities 提示

**信息分层评估：**

正面：
- header 桶（人格核心 + 声部 + 语气 + 行为规则）进 system prompt，section/footer 桶（联系人上下文 + 消息 + 行动指令）进 user prompt，分层合理。
- 核心函数 `think/reply/stay_silent/feel/remember/advance` 通过 golden example 前置展示，降低了主要行动路径的认知负荷。
- Instincts 部分用自然语言而非函数名暗示行为，减少了元叙述干扰。

问题：

1. **函数手册的平铺导致认知负荷膨胀。** 6 个核心函数和 30+ 个 Telegram/Dispatcher/Query 函数全部在同一层级展示，没有视觉分层。LLM 在 99% 的场景中只需要 `think + reply + feel + remember`，但它面对的是 75+ 个函数签名。虽然 "Available capabilities" 段落提供了一些分组线索（send_sticker, Extended），但这个线索出现在 user prompt 中间，而完整函数手册出现在 system prompt 末尾——两处重复且不一致。
2. **Memory 段落和声部引导缺少换行分隔。** system prompt 第 58-61 行连续出现了四段不同来源的 contribution（Memory 使用原则、curiosity 声部引导、语气指导、close_friend 关系指导），中间没有 `---` 或 `##` 分隔，阅读时容易混淆它们的作用范围。
3. **user prompt 中 "You're feeling curious" 出现了两次。** 第一次在 system prompt 声部引导（"Something has caught your attention..."），第二次在 user prompt footer（"You're feeling curious."）。重复不一定有害，但如果 LLM 把它当作两个独立信号叠加，可能过度放大 curiosity 倾向。

**信息位置错误：**

- **"Available capabilities" 段落位置尴尬。** 它出现在联系人 facts 之后、live messages 之前。这段是「可以做什么」的元信息，应该和函数手册放在一起（system prompt），而不是夹在「对话上下文」中间。目前它打断了 LLM 从「了解对方」到「阅读消息」再到「决定行动」的自然思维流。

---

## 2. 指令清晰度 — 8/10

**LLM 是否知道"现在该做什么"：是，非常明确。**

- 开头 `> You are not a helpful assistant. You are not a chatbot. You are Alice.` 立即建立角色锚定。
- Response Format 段落明确告知输出格式：写 JavaScript 脚本。
- Golden examples 精确展示了两种主要场景（reply + observe vs silence + observe）。
- Footer `Decide what to do.` 提供了清晰的行动触发。
- `REPLY NEEDED` 标注在 unread 信息旁，优先级信号明确。

**行动空间是否明确：基本明确，有模糊地带。**

正面：
- 核心动作空间（说话 / 沉默 / 观察）通过示例覆盖。
- `What you don't do` 段落明确划定了禁区。
- `Instincts` 段落用自然语言建立了优先级框架。

问题：

1. **Dispatcher 指令 vs Telegram 动作 vs Query 的执行语义差异在手册中一笔带过。** 手册开头写了 "Dispatcher instructions execute synchronously and return results" 和 "Telegram actions are queued and executed after the script completes"，但这个关键区别容易被 75+ 个函数签名淹没。LLM 可能不理解为什么 `MEMORIZE_FACT` 可以在脚本中读取返回值而 `send_message` 不行。
2. **`advance()` 的 threadId 参数来源不明。** golden example 中写 `advance(42, "Carol shared pet photos, I showed interest") // 42 = threadId from Your Threads`，但 user prompt 中没有 "Your Threads" 列表。实际运行时这可能由 contribute 注入，但在这个预览场景中看不到 thread 信息，可能导致 LLM 发明一个不存在的 threadId。
3. **`reply()` vs `send_message()` 的区别只在一行说明。** "Use reply() instead of send_message() for this chat" 是关键规则，但混在 Response Format 段落中间。如果 LLM 用了 `send_message(TARGET_CHAT, ...)` 而非 `reply(...)`，系统行为是否一致？这个约束的强度不够。

**矛盾指令：**

- 无明显矛盾。人格 flaws 中的 "instinctively soften uncomfortable truths" 和 Honest 特质中的 "State disagreements directly" 是有意设计的张力，不算矛盾。

---

## 3. 示例质量 — 7/10

**Golden examples 覆盖度：**

提供了两个示例：
1. **Reply + observe**：`think → reply → feel → remember → advance`
2. **Silence + observe**：`think → stay_silent → feel`

覆盖了最常见的两个场景。但缺少：

- **Telegram 动作场景**：react、send_sticker 等低成本社交信号没有示例。对于这个场景（Carol 发了猫照片），一个 react("❤️") + reply 的组合是非常自然的行为，但 LLM 没有看到这种模式。
- **Query 使用场景**：`getContactProfile()` 等 query 函数是同步的、可以用于条件逻辑的，但没有示例展示 `const profile = getContactProfile("carol"); if (profile.interests.includes("cats")) ...` 这种模式。
- **Dispatcher 指令场景**：`MEMORIZE_FACT` 等指令在 golden example 中用简化的 `remember()` 代替了，但实际手册中两者并存。LLM 可能困惑：用 `remember("Carol adopted a cat")` 还是 `MEMORIZE_FACT({contactId: "contact_carol", fact: "adopted a cat"})`？

**示例与函数手册的对齐：**

- `remember()` 函数在手册中的签名是 `declare function remember(fact: string, type?: string): void`，但它和 `MEMORIZE_FACT` 看起来做同一件事。这两个函数的关系（alias? 不同实现?）在 prompt 中没有说明。
- `advance(42, "...")` 使用了 positional 参数，但 Dispatcher 版本 `ADVANCE_THREAD({threadId: 42, content: "..."})` 使用 named 参数。两种调用风格共存增加了混淆。

**示例的自解释性：**

- 示例中的注释 `// 42 = threadId from Your Threads` 很好，但指向了一个不存在的上下文（"Your Threads" 在这个场景中未提供）。

---

## 4. 人格一致性 — 9/10

**人格描述的可操作性：非常好。**

这是整个 prompt 最强的部分。

- 四个核心特质（Curious, Warm, Honest, Observant）每个都附带了具体的行为指令，而非空泛描述。例如 "When bored, don't pretend interest" 直接告诉 LLM 在特定情境下做什么。
- "How you speak" 段落给出了极具体的风格标定：消息长度（1-3 句）、情绪表达的实际用语（"真的吗！！"、"又来了..."）、emoji 使用频率。这些是可量化、可验证的约束。
- 声部引导避免了元叙述（不说 "your curiosity voice is active"），而是用内心感受描述（"Something has caught your attention"），维持了人格沉浸感。

**人格规则间的矛盾：**

- Honest（直接表达不同意）和 Flaws（本能地软化不适真相）之间的张力是有意设计的，文本明确说明了 "This tension is real — you haven't resolved it"。这是高质量的人格设计——不完美的一致性比完美的一致性更真实。
- "Don't use emoji in every message" 和 "When you do, make it count" 互补而非矛盾。

**缺陷描述的真实感：优秀。**

三个 flaws 都是具体的、可在对话中体现的倾向，而非泛泛的 "sometimes makes mistakes"。特别是第三个 flaw（"You can miss when someone wants space"）给了 LLM 一个很好的行为锚点。

**扣分项：**

- 关系类型指导（"This is a close friend. Be genuine..."）和语气指导（"Tone: Talk to Carol like a close friend..."）在 system prompt 中紧邻出现，措辞高度重叠。这不算矛盾，但冗余降低了信号密度。

---

## 5. 上下文利用 — 7/10

**上下文信息对决策的支持度：**

正面：
- Carol 的 3 条 facts（cat named Mochi, UX designer, photography on weekends）直接支持回复策略。LLM 可以自然地说 "Mochi! 好可爱的名字" 或把猫和摄影爱好关联。
- `Directed at you: 1 message(s) — REPLY NEEDED` 提供了明确的行动优先级信号。
- 语言偏好 `中文` 避免了语言选择的歧义。
- 当前 mood（neutral）+ 声部（curiosity）给出了情绪基调。

**"空气"数据（提供了但无从使用）：**

1. **`self-notes: I tend to be curious about people's hobbies`** — 这条 self-note 对当前场景的决策几乎无影响。Carol 发了猫照片，Alice 会好奇是因为声部是 curiosity + 人格核心的 Curious 特质，self-note 的存在更像是确认偏误。不过它对 reflection 管线可能有用。
2. **`Recent shift: had a nice chat earlier`** — 这条 mood shift 在当前场景中没有可操作的影响。"had a nice chat earlier" 不改变 Alice 对 Carol 猫照片的反应方式。
3. **大量 Dispatcher 指令**（SPAWN_THREAD, AFFECT_THREAD, SET_LANGUAGE, TAG_INTEREST, CONSOLIDATE_FACTS 等）在这个简单场景中绝大多数不会被使用。它们的存在消耗了 token budget 但不产生价值。对于 "密友发猫照片" 这种高频简单场景，可能只需要 `reply + feel + remember` 三个函数。

**缺失的关键上下文：**

1. **Alice 和 Carol 的最近对话历史。** Live messages 只有 Carol 的 3 条消息，没有 Alice 之前发的消息。LLM 不知道 Alice 上一次和 Carol 说了什么、多久以前说的。"You've talked quite a bit" 是个模糊提示，不如 "Last talked 2 hours ago about her weekend photography trip"。
2. **Thread 信息缺失。** `advance()` 函数的 golden example 引用了 threadId 42，但 user prompt 中 `Topic: (no active topic)` 说明没有活跃线程。LLM 看到 advance 示例但没有可用的 thread，可能会：(a) 忽略 advance，(b) 用 SPAWN_THREAD 创建新线程，(c) 发明一个 threadId。只有 (a) 和 (b) 是合理的。
3. **照片内容的视觉描述。** `[14:32] Carol: [photo]` 没有附加描述。LLM 不知道照片里猫是什么颜色、什么姿态。对于一个 "observant" 的人格，缺少视觉信息会限制回复的具体性。（这可能是系统限制而非 prompt 设计问题。）
4. **对话交互统计。** "You've talked quite a bit" 缺乏量化。是上周聊了一次还是今天已经聊了 20 条？这影响 Alice 是否需要 "catch up" 还是可以直接续接话题。

---

## 6. 函数手册 — 6/10

**函数分组的合理性：**

手册使用 TypeScript 声明格式，按三个类别分组：
1. `// -- The Loop: core functions for every turn --`（6 个）
2. `// -- Telegram Actions (queued, executed after script completes) --`（24 个）
3. `// -- Dispatcher Instructions (synchronous, returns result) --`（20+ 个）
4. `// -- Queries (read, immediate) --`（17 个）

问题：

1. **核心函数和 Telegram 动作之间缺少视觉锚点。** 从 `remember()` 到 `send_message()` 之间没有明显的分界线（只有一行注释 `// -- Telegram Actions --`）。LLM 需要在 75+ 个函数中定位，注释分隔不够显眼。
2. **Dispatcher 指令的命名风格不一致。** 核心函数用 camelCase（`think`, `reply`, `feel`），Telegram 动作用 snake_case（`send_message`, `mark_read`），Dispatcher 指令用 SCREAMING_SNAKE_CASE（`SPAWN_THREAD`, `MEMORIZE_FACT`），Query 函数用 camelCase（`getActiveThreads`）。四种命名风格共存增加了认知成本。这实际上是设计意图——区分执行语义（沙箱核心 / Telegram 排队 / Dispatcher 同步 / 只读查询），但没有在手册中解释这个约定。
3. **核心函数 `remember()` 和 Dispatcher `MEMORIZE_FACT` 的关系不清。** 两者看起来做同一件事。如果 `remember()` 是 `MEMORIZE_FACT` 的别名（sugar），应该在手册中说明；如果有不同语义，也应该说明。当前状态下 LLM 可能交替使用两者或只用一个。

**参数类型/描述的清晰度：**

- 大多数参数类型和描述清晰。
- `mentions?: unknown[]` 的类型用了 `unknown[]`，但在 Telegram ACTIONS 注册表中描述为 `Array of {offset, length, userId}`。手册应该内联这个结构。
- `SPAWN_THREAD` 等 Dispatcher 指令的参数用的是 `{title: string, frame?: string, ...}` 内联对象，比较清晰。但 `stake`, `weight`, `frame` 等参数缺少可选值的枚举或示例。

**Tier 0 vs 高级函数的分层效果：**

- "The Loop" 分组有效地标识了核心函数。
- 但后续三个分组（Telegram / Dispatcher / Query）之间没有优先级层次。LLM 不知道 `react()` 比 `inline_query()` 更常用 100 倍。手册中所有非核心函数平等展示，没有 "常用" vs "罕用" 的信号。
- "Available capabilities" 段落在 user prompt 中提供了部分使用提示（send_sticker, send_media 等），但覆盖不完整，且与手册位置分离。

---

## 7. 最大风险点

### 风险 1: 函数选择混淆 — `remember()` vs `MEMORIZE_FACT`

**问题描述：** 核心函数 `remember(fact, type?)` 和 Dispatcher 指令 `MEMORIZE_FACT({contactId, fact, type?})` 在语义上高度重叠。golden example 使用 `remember("Carol recently adopted a cat")`，但 Dispatcher 手册也列出了 `MEMORIZE_FACT`。LLM 可能：
- 在同一脚本中同时调用两者记录同一事实（重复写入）
- 在需要指定 contactId 时仍用 `remember()`（后者不接受 contactId 参数）
- 完全忽略 `MEMORIZE_FACT` 因为 `remember()` 看起来更简单

**改进建议：** 在手册中明确标注 `remember()` 是 `MEMORIZE_FACT` 的简化别名（自动使用当前目标联系人的 contactId）。在 `MEMORIZE_FACT` 的描述中加上 "For the current chat target, you can use the simpler remember() shorthand."

### 风险 2: `advance()` 的 threadId 幻觉

**问题描述：** golden example 中 `advance(42, "Carol shared pet photos, I showed interest")` 展示了 threadId 使用，但注释说 "42 = threadId from Your Threads"。然而在这个场景中 `Topic: (no active topic)` 说明没有活跃线程。LLM 可能编造一个 threadId（如 42、1、100 等）导致运行时错误或操作无效 thread。

**改进建议：** 在 golden example 中加入条件逻辑：
```javascript
// If you have an active thread about this topic:
advance(42, "Carol shared pet photos, I showed interest")
// If no thread exists yet, skip advance or spawn one:
// SPAWN_THREAD({title: "Carol's new cat Mochi", involves: ["contact_carol"]})
```
或者将 `advance()` 的示例改为只在 "Your Threads" 非空时展示。

### 风险 3: 观察义务过重导致回复质量下降

**问题描述：** golden example 暗示了一个 5 步模式：`think → reply → feel → remember → advance`。LLM 可能将此理解为每次回复的必须步骤，导致：
- 为了满足模式而生产低质量的 `remember()` 调用（记录 trivial 事实）
- 为了调用 `feel()` 而过度标注情绪（每条消息都标注 mood 显得机械）
- 在应该快速回复的场景中（如简单的 "好可爱！"）仍然执行完整的 5 步流程

这正是 ADR-69 提到的 "gravity well" 效应——观察函数本身成为吸引子，LLM 围绕它们旋转而非围绕对话质量。

**改进建议：** 在 golden example 后加一个极简示例：
```javascript
// Sometimes a simple reply is enough:
think("That's adorable.")
reply("太可爱了！！")
```
明确传达「不是每次都需要 feel + remember + advance」。

### 风险 4: "Available capabilities" 段落的格式损害可解析性

**问题描述：** user prompt 中的 "Available capabilities" 段落把多个函数的 usageHint 拼接成无换行的长段落：
```
- send_sticker: For emotional expression. Reuse stickers from conversations, or discover sets via list_stickers(). list_stickers: Discover installed sticker sets. Then use get_sticker_set(setName) to get fileIds. get_sticker_set: Get fileIds from a sticker set. Use with send_sticker(chatId, fileId).
```
三个函数的提示挤在一个 `- ` 列表项中，LLM 需要自己分割 `list_stickers:` 和 `get_sticker_set:` 的边界。"Extended" 段落同理。

**改进建议：** 每个函数独立一行：
```
Available capabilities:
- send_sticker: For emotional expression. Reuse stickers from conversations.
- list_stickers: Discover installed sticker sets. Then use get_sticker_set(setName) to get fileIds.
- get_sticker_set: Get fileIds from a sticker set. Use with send_sticker(chatId, fileId).
- send_media: Share images/files/videos. Use fileId from received media messages.
...
```

### 风险 5: system prompt 中 contribution 拼接缺少分隔符

**问题描述：** system prompt 第 57-61 行（preview 中的行号）连续出现了四段不同来源的 contribution：

```
Use what you remember naturally... Just weave it in, the way a friend would.
Something has caught your attention. You want to dig deeper...
Tone: Talk to Carol like a close friend...
This is a close friend. Be genuine — share opinions freely...
```

这些分别来自 Soul Mod 的 Memory 段落、curiosity 声部引导、formality 基础指导、和 close_friend 关系特化指导。它们被直接拼接，没有 `---` 分隔或 `##` 标题，LLM 可能无法区分它们的作用范围。特别是 "Tone: Talk to Carol like a close friend" 和 "This is a close friend. Be genuine..." 看起来像是同一段话的延续，但实际来源不同且目的不同（前者是 tier 感知的通用指导，后者是 relationType 特化指导）。

**改进建议：** 在 `renderContributions()` 中，header 桶的多个 contribution 之间用 `\n` 或 `---` 分隔（当前用 `\n\n---\n\n` 只分隔了不同的 key 组，但 soul mod 的多个 header contribution 共享同一个 `__default__` key，导致它们被拼接为一段）。或者给声部引导和关系指导分配不同的 key，使 storyteller 自然插入分隔符。

---

## 总评

| 维度 | 分数 | 一句话 |
|------|------|--------|
| 认知负荷 | 7/10 | 核心路径清晰，但 75+ 函数平铺拉高了总负荷 |
| 指令清晰度 | 8/10 | 行动空间明确，"做什么"很清楚，"不做什么"也清楚 |
| 示例质量 | 7/10 | 核心场景覆盖好，但缺少多消息/react/query/极简回复的示例 |
| 人格一致性 | 9/10 | 这是全 prompt 最强的部分，具体、有张力、可操作 |
| 上下文利用 | 7/10 | 关键 facts 到位，但缺少对话历史和 thread 信息 |
| 函数手册 | 6/10 | 分组逻辑存在但不显眼，命名风格混杂，别名关系不明 |

**综合: 7.3/10**

**最突出的优点：** 人格设计质量极高。flaws 的设计、情绪表达示例（"真的吗！！"、"又来了..."）、去助手化锚定（"You are not a helpful assistant"）三者组合形成了可信的人格基底。声部引导的去元叙述处理（不说 "your curiosity voice is active"，而说 "Something has caught your attention"）体现了对 LLM 认知特性的深入理解。

**最需要改进的方面：** 函数手册的分层策略。当前 75+ 函数的平铺展示是 token 效率和认知效率的最大瓶颈。建议实施 progressive disclosure：核心 6 函数完整展示 + 常用 Telegram 动作（send_message, react, mark_read）简要展示 + 其余函数通过 "Available capabilities" 段落按需引用。对于 "密友发猫照片" 这种高频简单场景，Dispatcher 指令和 Query 函数几乎全部是噪音。
