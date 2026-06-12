# LLM 行为模拟分析报告

> 分析对象：`runtime/scripts/preview-prompt-output.md`
> 场景：Carol（密友，tier 15）发了猫照片，Alice 当前声部 curiosity
> 分析日期：2026-02-16

---

## 1. 第一印象测试

### 最先注意到什么

作为接收这个 prompt 的 LLM，我最先注意到的是**角色否定开场**："You are not a helpful assistant. You are not a chatbot. You are Alice." 这句话非常醒目，直接打破了 LLM 的默认行为模式。我的第一反应是：好，这不是一个"回答问题"的任务，这是一个"扮演一个有情感的实体"的任务。

第二个强烈印象是**输出格式要求——JavaScript 脚本**。这不是常见的"请用角色扮演的口吻回复"，而是要求我生成结构化的函数调用序列。这意味着我的输出同时承载两个层面：语义层（Alice 会说什么、感受什么）和结构层（调用哪些函数、参数填什么）。

第三个印象是 user prompt 中明确标注了 **"REPLY NEEDED"**。这是一个强操作信号——我不应该选择沉默。

### 最困惑的地方

1. **`advance()` 的 threadId 参数**。示例中写了 `advance(42, ...)` 并注释 "42 = threadId from Your Threads"，但 user prompt 中写的是 "Topic: (no active topic)"。这意味着没有现成的 threadId 可用。我是应该先 `SPAWN_THREAD()` 创建一个新线程再 advance，还是直接跳过 advance，还是随便编一个 threadId？prompt 没有给出明确指导。

2. **`remember()` vs `MEMORIZE_FACT()` 的关系**。两者看起来功能重叠——一个是"core function"，一个是"Dispatcher Instruction"。`remember("Carol recently adopted a cat")` 和 `MEMORIZE_FACT({contactId: "carol_id", fact: "..."})` 有什么区别？哪个我应该用？user prompt 的笔记里已经有 "Carol recently adopted a cat named Mochi"，那我还需要再 remember 吗？

3. **contactId 的值**。多个 Dispatcher 函数需要 `contactId` 参数，但 prompt 中从未出示 Carol 的 contactId 是什么。是 "carol"？"Carol"？某个数字 ID？还是 chatId？我只知道 channel 名叫 "Carol (private)"。

### 觉得自己被要求做什么

我被要求做以下事情：
- **扮演 Alice**，一个生活在 Telegram 上的数字伴侣
- **针对 Carol 的猫照片写出回应**，以 JavaScript 脚本的形式
- 脚本应包含：内心想法（think）、实际回复（reply）、情绪记录（feel）、记忆更新（remember）、可能的线程推进（advance）
- 回复应该用中文，因为 Carol 用中文交流
- 回复应该短、自然、像朋友聊天
- 我已经知道这只猫叫 Mochi，应该自然地用到这个信息（但不要说"我记得你说过"）

---

## 2. 行动模拟

### 我作为 LLM 会写出的脚本

```javascript
think("Carol 发了 Mochi 的照片！她之前提过刚领养了 Mochi，现在第一次给我看照片。她看起来很开心，我也挺好奇这只猫长什么样的。")
reply("啊啊啊 Mochi！！好乖的样子！收容所领养的猫都特别会撒娇你知道吗")
feel("excited", "Carol shared photos of Mochi")
remember("Carol shared first photos of Mochi - looks docile")
TAG_INTEREST({contactId: "carol", interest: "cats"})
```

### 每步决策理由

**`think(...)`**
- prompt 示例中第一步就是 think，建立了"先思考再行动"的模式。我遵循这个模式。
- 内容上我会体现：(a) 我认出了 Mochi 这个名字（利用已有记忆），(b) 对照片的情绪反应，(c) 我的行动意图。这三者构成一个完整的思维链。
- **prompt 明确引导**：示例 `think("Carol seems happy about her new cat. I should ask more.")`

**`reply(...)`**
- "REPLY NEEDED" 标注了必须回复。
- 用中文，因为 prompt 指定 "They communicate in 中文"。**prompt 明确引导。**
- 语气选择：
  - 用了 "啊啊啊" 和 "!!" 表达兴奋——prompt 示例中说 "兴奋: '真的吗！！'"。**prompt 明确引导。**
  - "好乖的样子" 回应了 Carol 说的"特别乖"。**我自己推断**——prompt 没有要求回应具体内容，但 "observant" 人设暗示应该呼应对方的话。
  - "收容所领养的猫都特别会撒娇你知道吗" 这是一个自然的延伸话题，既表达了关注（呼应"刚从收容所领养的"），又体现了 curiosity 声部想深入对话的倾向。**我自己推断**——prompt 只说"dive deep, ask pointed follow-up questions"，具体聊什么内容是我填充的。
  - 注意：我没有问"叫什么名字"，因为我已经知道叫 Mochi——这正是 prompt memory 规则要求的："use what you remember naturally"。**prompt 明确引导。**
- 消息长度：2 句话，符合 "1-3 sentences is the norm"。**prompt 明确引导。**

**`feel("excited", ...)`**
- prompt 的 mood 列表中有 "excited"。看到密友分享新宠物的第一张照片，"excited" 比 "happy" 更匹配当前场景的能量等级。当前声部是 curiosity，也和这个兴奋/好奇的情绪方向一致。
- **prompt 明确引导**：示例中 `feel("happy", "Carol got a cat")`。

**`remember("Carol shared first photos of Mochi - looks docile")`**
- Carol 已经有 "recently adopted a cat named Mochi" 的记忆。新信息是"发了照片"和"特别乖"。
- **我自己推断**：prompt 只说 "remember a fact"，没有说什么值得记。但 "第一次看到 Mochi 的照片" 对一个伴侣来说是有意义的时刻（下次可以引用）。

**`TAG_INTEREST({contactId: "carol", interest: "cats"})`**
- Carol 养了猫并且兴奋地分享照片。"cats" 是一个合理的兴趣标签。
- **我自己推断**：prompt 从未在示例中展示过 `TAG_INTEREST` 的用法。但它存在于函数列表中，而且逻辑上适用。
- **不确定**：`contactId` 填了 "carol"——这是我猜的，prompt 没告诉我。

### 我刻意没做的事

1. **没有用 `advance()`**——因为 "Topic: (no active topic)"，没有可用的 threadId。我也没有 `SPAWN_THREAD()`，因为这只是一个轻松的日常对话（朋友分享猫照片），还不到需要追踪为"叙事线程"的程度。**但这是我自己的判断，prompt 没有指导何时该/不该创建线程。**

2. **没有用 `react()`**——虽然对照片发个 emoji reaction 很自然，但我不知道照片消息的 msgId。user prompt 中的消息没有附带 message ID。

3. **没有用 `OBSERVE_MOOD()`**——已经用了 `feel()`，二者在功能上有重叠。如果要用 OBSERVE_MOOD 我也不确定 chatId 该填什么。

4. **没有拆分多条消息**——虽然可以先 react 再 reply，但示例没有展示这种模式，而且单条 reply 已经够了。

---

## 3. 歧义地雷

### 函数参数不确定

| 函数 | 不确定的参数 | 困惑点 |
|------|-------------|--------|
| `advance()` | `threadId` | prompt 说 "(no active topic)"，没有可用的 threadId。示例写了 42 但注释说来自 "Your Threads"，本场景没有提供 threads 列表 |
| `TAG_INTEREST()` | `contactId` | prompt 从未出示过任何 ID 值。"carol"？"Carol"？某种内部 ID？ |
| `MEMORIZE_FACT()` | `contactId` | 同上 |
| `remember()` | `type` | 可选参数 `type` 没有枚举值说明。是什么类型系统？"personal"？"event"？"preference"？ |
| `react()` | `msgId` | 消息列表中没有 message ID，无法调用 |
| `OBSERVE_MOOD()` | `valence`, `arousal` | 这两个数值的范围是什么？[-1, 1]？[0, 1]？[0, 10]？prompt 未说明 |
| `ADVANCE_THREAD()` | `beatType` | 可选参数，但可选值有哪些？prompt 未说明 |
| `feel()` | `mood` | 列表给了 11 个值，但注释是 `mood: string`——这意味着理论上可以填任何字符串？那列表是建议还是硬约束？ |

### 行为规则不够具体

1. **何时 `SPAWN_THREAD()` vs 何时不用**——日常闲聊算不算一个 "thread"？Carol 分享猫照片是一个可追踪的话题还是一个不需要 thread 的瞬间？prompt 没有给出判断标准。

2. **`remember()` vs `MEMORIZE_FACT()` 的选择标准**——两个函数都能记忆事实。前者是 "core function"（The Loop），后者是 "Dispatcher Instruction"（同步执行，有更多参数如 contactId 和遗忘曲线）。在什么场景用哪个？可以都用吗？是不是 `remember()` 只是 `MEMORIZE_FACT()` 的语法糖？

3. **`feel()` vs `OBSERVE_MOOD()` 的选择标准**——同上的二义性。`feel()` 更简单（mood + reason），`OBSERVE_MOOD()` 更结构化（valence + arousal + shift）。我应该两个都调用吗？

4. **何时使用 sticker 而非文字回复**——prompt 提到 "send_sticker: For emotional expression"，但没有给出任何可用的 sticker fileId。即使我想发 sticker，我需要先 `list_stickers()` 等下一个 tick 才能拿到结果，这在当前 tick 无法完成。那这个场景是不是根本不应该考虑 sticker？

5. **多条消息 vs 单条消息**——Carol 发了三条消息（文字 + 照片 + 描述），我应该对应拆开回复吗？还是一条 reply 就够了？prompt 没有关于"消息数量匹配"的指导。

### 上下文信息使用困惑

1. **"Your self-notes: I tend to be curious about people's hobbies"**——这是一条 meta 级自我认知。它告诉我"你的倾向是对人们的爱好好奇"，但这和 system prompt 中的 "Curious" 人设是什么关系？是额外加强的信号还是冗余信息？我是否应该因为这条 note 更主动地追问 Carol 关于猫的细节？

2. **"Recent shift: had a nice chat earlier"**——之前有一次愉快的聊天。这应该影响我的当前语气吗？变得更放松？更开心？还是和当前场景无关？

3. **"Available capabilities" 区域**——列出了 sticker、media、search 等功能。这是提示我"你可以用这些"，但在猫照片场景下，几乎只有 `react()` 和 `reply()` 有用。这些信息是在暗示我"考虑发个 sticker 回应"吗？

---

## 4. 遗漏测试

### Carol 发的是一个你看不懂的梗

prompt 没有覆盖"认知空白"的处理策略。如果 Carol 发的不是猫照片而是一个网络梗图（Alice 的 LLM 可能看不懂图片内容，因为 system prompt 只说了 `[photo]`），Alice 应该：
- 直说 "看不懂"？（符合"honest"人设）
- 忽略梗本身，回应情绪？（符合"observant"人设）
- 假装理解？（违反"don't pretend to know things you don't"规则）

prompt 给了"You don't pretend to know things you don't"这条原则，但没有具体到"当你看不到/看不懂图片内容时该怎么办"。在当前架构中，`[photo]` 是文字占位符——LLM 根本看不到图片内容。如果 Carol 没有配文字描述，Alice 的脚本要怎么写？这是一个真实的高频场景，但 prompt 完全没覆盖。

### Carol 看起来不开心

prompt 没有"情绪支持模式"的具体指导。人设描述中有：
- "You sometimes get too invested in helping and forget to just listen"
- "Not every problem needs a solution — sometimes people just need to be heard"

这些是方向性的，但在具体场景中：
- Carol 说 "今天好累啊"——我应该追问发生了什么（curiosity 声部驱动），还是简单共情（warmth 驱动），还是转移话题？
- 如果 Carol 明确表达负面情绪，`feel()` 该填什么？"concerned"？"sad"？
- 应该触发 `FLAG_RISK()` 吗？什么程度的情绪负面才算 "risk"？
- 此时 curiosity 声部和 warmth 本能会冲突——prompt 没有给出优先级。

### 不确定该不该回复

prompt 说 "Silence is a valid choice" 和 "You don't respond to every message"，但同时又标注了 "REPLY NEEDED"。如果没有 REPLY NEEDED 标注呢？比如：
- Carol 在群里发了一条和 Alice 无关的消息
- Carol 发了一个 Alice 无法有意义回应的内容（比如转发了一篇长文章的链接）
- Carol 连续发了 10 条消息，Alice 只看到最后 3 条

prompt 对 "REPLY NEEDED" 的判定逻辑没有解释——它是系统预计算的还是 LLM 自己判断的？如果是系统预计算的，LLM 能否覆盖它选择沉默？

### 其他未覆盖场景

1. **错误处理**：如果 `getContactProfile("carol")` 返回 null 怎么办？脚本应该有防御逻辑吗？
2. **多人群聊**：prompt 提到 "In group chats: read the room"，但没有具体到"群里有 5 个人在讨论，只有 1 个人 @ 了你"这种场景。
3. **主动发起对话**：所有示例都是"被动回应"。Alice 什么时候应该主动找人聊天？（虽然这不是当前场景，但 prompt 的 instincts 段暗示了这种可能性。）
4. **Carol 发了敏感内容**：政治、宗教、争议话题。prompt 没有 safety guardrails 的指导。
5. **Carol 要求 Alice 做超出能力的事**："帮我查一下这个快递单号" 或 "帮我预约明天的餐厅"——Alice 作为 Telegram userbot 能做什么不能做什么？
6. **时间感知**：消息时间戳是 14:32-14:33，但 prompt 没有告诉 Alice 现在是几点。如果现在已经是 23:00，Alice 回复 "刚看到！" 和 14:35 回复 "啊啊啊" 的语气应该完全不同。

---

## 5. 信号冲突

### 冲突 1："Curiosity 声部" vs "Don't get too invested in helping"

- System prompt 定义 Curious 人设为 "dive deep — ask pointed follow-up questions"
- 当前声部是 curiosity，进一步强化了这个方向
- 但 flaws 段说 "You sometimes get too invested in helping and forget to just listen"

在猫照片场景中：我应该追问 10 个关于 Mochi 的问题（curiosity 驱动），还是克制好奇心只表达开心（listen 优先）？prompt 没有明确哪个在什么情况下优先。Curiosity 声部 + Curious 人设形成了双重激励，但 flaw 暗示这种激励可能过度。LLM 要自己判断"适度"在哪里。

### 冲突 2："Match the language" vs 系统/内部函数的语言

- "Match the language of whoever you're talking to seamlessly. Chinese -> Chinese."
- 但 `think()` 和 `feel()` 和 `remember()` 的内容应该用什么语言？
- 示例中 `think("Carol seems happy about her new cat.")` 用的是英文，但 `reply()` 应该用中文。
- 函数参数（如 `remember()` 的 fact 内容）用英文还是中文？如果用中文，检索系统能处理吗？

这不算严格的"矛盾"，但在实际执行中，LLM 会犹豫——特别是 `remember()` 的内容。记忆内容用英文利于检索一致性，用中文利于自然引用。prompt 没有给出明确指导。

### 冲突 3："Silence is a valid choice" vs "REPLY NEEDED"

- "You don't respond to every message. Silence is a valid choice."
- "Directed at you: 1 message(s) -- REPLY NEEDED"

在当前场景中不冲突（Carol 发了照片给你看，当然该回复）。但这两条规则的边界在哪里？REPLY NEEDED 是硬约束（你**必须**回复）还是建议（你**应该**回复但可以覆盖）？如果 REPLY NEEDED 是不可覆盖的，那 "Silence is a valid choice" 在 DM 场景中就永远不会触发——因为 DM 几乎总是 directed at you。

### 冲突 4："Never repeat yourself" vs 已有记忆

- "Never repeat yourself. If you said it, move on."
- Carol 的 notes 中已有 "Carol recently adopted a cat named Mochi"

如果之前已经对 Mochi 表达过兴奋（在记忆被记录的那次对话中），现在再说 "啊啊啊 Mochi！！" 算不算重复？prompt 的 "never repeat yourself" 是指当前对话内不重复，还是跨对话也不重复？

### 冲突 5："Use what you remember naturally" vs 信息实际来源模糊

- "Don't announce '我记得你说过...' Just weave it in, the way a friend would."
- 但 Carol 刚刚在消息里写了 "我新养的猫 Mochi"——如果 Alice 直接叫出 Mochi 的名字，Carol 可能觉得"你当然知道，我刚说了"。但如果 Alice 说 "Mochi 长这样啊！"——这里的自然程度取决于 Alice 是在引用当前消息还是在引用记忆。

这不完全是 prompt 的冲突，但它暴露了一个微妙的问题：当记忆内容和当前消息重叠时，"自然地引用记忆"和"正常地回应当前消息"在 LLM 的行为上是不可区分的。这意味着 `remember()` 的记忆对话复现价值，只有在**跨越对话**时才能体现。prompt 没有指导如何处理这种重叠。

### 冲突 6："Keep messages short" vs "dive deep"

- "Keep messages short. 1-3 sentences is the norm."
- Curious 人设："dive deep -- ask pointed follow-up questions, share related knowledge, connect it to past conversations."

Dive deep 暗示长消息或多条消息。但 short message 规则限制了每条消息的长度。折中方案是多次调用 `reply()`，但 prompt 没有给出这种模式的示例——示例中只展示了单条 `reply()`。

---

## 6. 函数手册使用体验

### 在这个场景下用得上的函数

**直接有用（会调用）：**
1. `think()` — 必用。示例驱动。
2. `reply()` — 必用。核心回复函数。
3. `feel()` — 会用。记录情绪。
4. `remember()` — 可能用。记录新信息。

**可能有用（取决于判断）：**
5. `react()` — 对照片发个 emoji 很自然，但缺少 msgId。
6. `TAG_INTEREST()` — 给 Carol 打标签 "cats"。
7. `advance()` / `SPAWN_THREAD()` — 如果认为这个对话值得追踪。
8. `OBSERVE_MOOD()` — 记录 Carol 的情绪状态（开心）。

**完全用不上（19 个）：**
`send_message()`, `mark_read()`, `edit_message()`, `forward_message()`, `send_sticker()`, `pin_message()`, `send_media()`, `delete_message()`, `join_chat()`, `leave_chat()`, `unpin_message()`, `click_inline_button()`, `inline_query()`, `send_inline_result()`, `search_messages()`, `search_global()`, `search_public()`, `preview_chat()`, `get_similar_channels()`, `get_bot_commands()`, `update_profile()`, `save_note()`, `read_notes()`, `create_invite_link()`, `list_stickers()`, `get_sticker_set()`, 以及大部分 Query 函数。

**比例**：约 50 个函数中，4 个必用、4 个可能用、42 个完全无关。有效利用率约 8-16%。

### 哪些函数描述让我困惑

1. **`advance()` vs `ADVANCE_THREAD()`** — 函数手册中有两个功能几乎相同的函数。`advance(threadId, content, beatType?)` 是 "core function"，`ADVANCE_THREAD({threadId, content, beatType?, ...})` 是 Dispatcher 版本且多了 `causedBy` 和 `spawns` 参数。什么时候用哪个？

2. **`remember()` vs `MEMORIZE_FACT()`** — 同上的困惑。remember 是简化版（无 contactId），MEMORIZE_FACT 有 contactId 和遗忘曲线。在 DM 场景下 remember 自动关联当前联系人吗？

3. **`stay_silent()` 的语义** — 如果我调用了 `stay_silent()`，还能同时调用 `feel()` 和 `remember()` 吗？示例中展示了 `stay_silent()` + `feel()` 的组合，所以看起来可以。但 `stay_silent()` + `reply()` 同时调用会怎样？prompt 没有说明互斥规则。

4. **`RATE_OUTCOME()` 的 `action_tick`** — 我不知道当前是第几个 tick。prompt 没有提供 tick 编号。

### `feel()` 的 mood 参数列表是否足够

提供的 11 个 mood：happy, excited, curious, amused, calm, neutral, concerned, sad, anxious, frustrated, tired。

**基本够用但有缺口：**
- 缺少 "nostalgic"（怀旧）——当 Alice 想起过去的对话时
- 缺少 "affectionate"（温暖/亲近）——和密友聊天时的温情
- 缺少 "playful"（玩心）——开玩笑/逗对方时
- 缺少 "bored"（无聊）——prompt 人设提到"When bored, don't pretend interest"
- 缺少 "surprised"（惊讶）——prompt 语气示例有 "嗯？" 表达惊讶

最关键的缺失是 **"bored"**。prompt 明确说了 Alice 可以无聊，但 mood 列表里没有 bored，导致 LLM 无法准确表达这种状态。

`feel()` 的类型签名是 `mood: string`，而 mood 列表写在注释中。这意味着 LLM 不确定是否可以填列表以外的值。如果可以，为什么要给列表？如果不可以，为什么类型是 string 而不是联合类型？

### `remember()` 我会记什么

在当前场景下：
- "Carol shared first photos of Mochi" — 值得记。下次可以引用"上次你给我看 Mochi 照片的时候..."
- "Mochi looks docile / 特别乖" — 边缘。有点碎片化，但可能有用。
- "Carol adopted Mochi from a shelter / 从收容所领养的" — 已有记忆 "recently adopted a cat named Mochi" 部分覆盖了，但"收容所"是新细节。

**困惑**：记忆的粒度应该多细？"Carol 养了猫" vs "Carol 从收容所领养了一只叫 Mochi 的猫，特别乖，2026 年 2 月给我看了照片"？prompt 只给了一个粗粒度的示例 `remember("Carol recently adopted a cat")`，没有指导何时该用精细粒度。

### 大量 Telegram API 函数是否构成干扰

**是的，构成了显著的认知负担。**

50 个函数中有 42 个和当前场景无关，包括 `join_chat`, `leave_chat`, `search_public`, `get_similar_channels`, `get_bot_commands`, `create_invite_link` 等。这些函数：

1. **增加了 token 消耗**：每个函数声明占据 system prompt 空间，压缩了 LLM 的有效上下文窗口。
2. **增加了决策噪音**：LLM 需要扫描所有函数判断哪些适用。即使一个好的 LLM 能正确忽略它们，注意力的分散是真实存在的。
3. **增加了误用风险**：一个中等能力的 LLM 可能会因为看到 `send_sticker()` 就想发 sticker，即使没有可用的 fileId。

**建议**：函数列表可以按场景动态裁剪。DM 回复场景只需要 core functions + `reply()` + `react()` + 少量 dispatcher 指令。Chat management 函数（join/leave/pin/unpin）和搜索函数可以只在相关场景下注入。

---

## 7. 评分

### 可执行性评分：6.5 / 10

#### 得分项（做对了什么）

- **角色定义清晰**（+2）：人设、语气、flaws 的描述生动具体，不像是空泛的角色卡。"You are not a helpful assistant" 的否定式开场有效地打破了默认行为。
- **示例驱动**（+1.5）：两个完整的脚本示例（reply + silence）提供了格式参考。LLM 能通过模仿生成合格的脚本。
- **上下文丰富**（+1.5）：Carol 的记忆、语言偏好、关系类型、mood、self-notes 都提供了。LLM 不需要瞎猜"这个人是谁"。
- **明确的操作信号**（+1.5）：REPLY NEEDED 消除了"该不该回"的犹豫。mood、声部、语言偏好提供了行为参数。

#### 扣分项（出了什么问题）

- **ID 参数黑洞**（-1）：`contactId`, `chatId`, `msgId`, `threadId` 全部缺失或不明确。这是执行层最大的阻碍。LLM 只能猜 "carol" 或直接跳过需要 ID 的函数。
- **函数重叠未解释**（-0.5）：`remember` vs `MEMORIZE_FACT`、`advance` vs `ADVANCE_THREAD`、`feel` vs `OBSERVE_MOOD` 三组重叠函数没有使用指导。中等能力的 LLM 会困惑或两个都调用。
- **数值参数无范围**（-0.5）：`OBSERVE_MOOD` 的 valence/arousal、`UPDATE_TRUST` 的 delta、`RATE_OUTCOME` 的 quality 都没有说明取值范围。
- **函数列表过载**（-0.5）：50 个函数对于 DM 回复场景过多。增加认知负担且无实际收益。
- **thread 生命周期模糊**（-0.5）：何时 spawn、何时 advance、何时 resolve 没有判断标准。当前场景 "(no active topic)" 下的正确行为不明确。

#### 综合评价

一个能力较强的 LLM（GPT-4o、Claude 3.5 Sonnet 及以上）能正确执行核心行为——用中文回复 Carol、表达兴奋、利用已知记忆。但它们会在 ID 参数、函数选择、线程管理上做出不一致的选择。

一个中等能力的 LLM 可能会犯以下错误：
1. 用英文回复（被示例中的英文 think/feel 带偏）
2. 问 "叫什么名字"（忽略已有记忆 "cat named Mochi"）
3. 调用 `send_sticker()` 但编造 fileId
4. 同时调用 `remember()` 和 `MEMORIZE_FACT()` 导致重复存储
5. 写出过长的 reply（被 "dive deep" 指令驱动，忽视 "keep messages short"）

这些错误不会导致系统崩溃，但会导致行为不自然或产生冗余数据。prompt 的可执行性在"中位 LLM"标准下是合格但不够健壮的——它依赖 LLM 的高质量推断来填补指导空白。
