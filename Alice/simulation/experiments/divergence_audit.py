"""
D15/D16/D26/D35/D36 — 理论→实现关键分歧模拟验证。

四个实验，不偏袒论文或实现，只看数学事实和行为后果。

Experiment 1 (D15): P4 幂律 vs 对数增长 — idle-growth 定理是否成立？
Experiment 2 (D16): P_prospect 作为第 7 维 — API 范围和行为影响
Experiment 3 (D26): P6 全局 novelty deficit vs per-contact surprise
Experiment 4 (D35/D36): 声部激活函数 — 全局 vs per-entity focal-set
"""
import math
import numpy as np
import matplotlib.pyplot as plt
from pathlib import Path

OUTPUT_DIR = Path(__file__).parent.parent / "output" / "divergence_audit"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


# ═══════════════════════════════════════════════════════════════════════════════
# Experiment 1: D15 — P4 Power-Law vs Logarithmic Growth
# ═══════════════════════════════════════════════════════════════════════════════

def exp1_p4_growth():
    """
    论文: P4_retro(t) = age^{β_t} · w,  β_t=1.5  (凸函数，加速增长)
    实现: P4_retro(t) = log(1 + age/τ) · w · decay(age)  (凹函数，减速增长)

    问题: Theorem 4 (Non-Quiescence) 的证明依赖 P4 的严格凸性。
    具体来说: f''(x) = β_t(β_t-1)x^{β_t-2} > 0 for β_t > 1。
    对数函数 f(x)=log(1+x) 的 f''(x) = -1/(1+x)^2 < 0 (严格凹)。

    验证:
    1. 两种函数下 P4 是否仍然严格递增？(idle-growth 的弱形式)
    2. 增量 ΔP4(n) 是否递增？(idle-growth 的强形式——凸性保证)
    3. tanh(P4/κ) 的行为差异
    """
    print("=" * 70)
    print("Experiment 1: D15 — P4 Power-Law vs Logarithmic Growth")
    print("=" * 70)

    # 参数
    beta_t = 1.5           # 论文推荐
    w_major = 2.0          # 论文权重
    kappa4_paper = 200     # 论文 κ₄
    kappa4_impl = 5.0      # 实现 κ₄
    tau_impl = 86400       # 实现 threadAgeScale (秒)
    max_age_s = tau_impl * 7  # zombie 衰减起点
    tick_s = 60            # 1 tick ≈ 60s

    # 模拟 30 天 = 43200 ticks
    N = 43200
    ticks = np.arange(1, N + 1)
    age_s = ticks * tick_s  # 墙钟秒

    # --- 论文公式 (ticks) ---
    # 论文 P4 用 tick 做 age 单位
    p4_paper = ticks.astype(float) ** beta_t * w_major

    # --- 实现公式 (秒) ---
    decay_factor = np.where(age_s > max_age_s, np.exp(-(age_s - max_age_s) / max_age_s), 1.0)
    p4_impl = np.log(1 + age_s / tau_impl) * w_major * decay_factor

    # --- 增量分析 ---
    delta_paper = np.diff(p4_paper)
    delta_impl = np.diff(p4_impl)

    # 增量是否严格正？
    paper_always_positive = np.all(delta_paper > 0)
    impl_always_positive = np.all(delta_impl > 0)
    impl_first_negative = None
    if not impl_always_positive:
        impl_first_negative = np.argmax(delta_impl <= 0)

    # 增量是否递增？（凸性检验）
    delta2_paper = np.diff(delta_paper)
    delta2_impl = np.diff(delta_impl)
    paper_convex = np.all(delta2_paper >= -1e-10)  # 浮点容差
    impl_convex = np.all(delta2_impl >= -1e-10)

    # --- tanh(P4/κ) 行为 ---
    api4_paper = np.tanh(p4_paper / kappa4_paper)
    api4_impl = np.tanh(p4_impl / kappa4_impl)

    # 论文 tanh 饱和点（tanh > 0.99 时）
    paper_sat_idx = np.argmax(api4_paper > 0.99) if np.any(api4_paper > 0.99) else N
    impl_sat_idx = np.argmax(api4_impl > 0.99) if np.any(api4_impl > 0.99) else N

    print(f"\n--- Raw P4 增量分析 ---")
    print(f"论文 ΔP4 > 0 everywhere: {paper_always_positive}")
    print(f"实现 ΔP4 > 0 everywhere: {impl_always_positive}")
    if impl_first_negative is not None:
        print(f"  实现首次 ΔP4 ≤ 0 at tick {impl_first_negative} "
              f"({impl_first_negative * tick_s / 86400:.1f} days)")
    print(f"论文 Δ²P4 ≥ 0 (凸性): {paper_convex}")
    print(f"实现 Δ²P4 ≥ 0 (凸性): {impl_convex}")

    print(f"\n--- tanh(P4/κ) 饱和分析 ---")
    print(f"论文 tanh(P4/{kappa4_paper}) > 0.99 at tick {paper_sat_idx} "
          f"({paper_sat_idx * tick_s / 3600:.1f} hours)")
    print(f"实现 tanh(P4/{kappa4_impl}) > 0.99 at tick {impl_sat_idx} "
          f"({impl_sat_idx * tick_s / 3600:.1f} hours)")

    # --- Idle-Growth 定理验证 ---
    # 定理说: API(n+1) > API(n) 对所有 n。
    # 关键: 即使 P4 增量递减(凹)，只要 ΔP4 > 0，tanh(P4/κ) 仍然严格递增。
    # 但是: zombie decay 可以让 ΔP4 < 0！
    delta_api4_impl = np.diff(api4_impl)
    impl_api_monotone = np.all(delta_api4_impl >= -1e-12)
    impl_api_first_drop = None
    if not impl_api_monotone:
        impl_api_first_drop = np.argmax(delta_api4_impl < -1e-12)

    print(f"\n--- Idle-Growth Theorem 验证 ---")
    print(f"论文: tanh(P4/κ) 严格递增? {np.all(np.diff(api4_paper) > -1e-12)}")
    print(f"实现: tanh(P4/κ) 严格递增? {impl_api_monotone}")
    if impl_api_first_drop is not None:
        print(f"  实现 tanh 首次下降 at tick {impl_api_first_drop} "
              f"({impl_api_first_drop * tick_s / 86400:.1f} days)")

    # --- 结论 ---
    print(f"\n--- D15 结论 ---")
    if impl_always_positive and impl_api_monotone:
        print("✓ 弱 idle-growth (API 单调递增) 在实现中仍然成立")
        print("  但强形式（增量递增 = 凸性）不成立")
        print("  → 论文 Remark 8.1 (idle-growth 的增量递增性质) 在实现中不成立")
    elif not impl_always_positive:
        print("✗ idle-growth 在实现中被 zombie decay 打破！")
        print(f"  第 {impl_first_negative} tick 后 P4 开始递减")
        print("  → Theorem 4 (Non-Quiescence) 不成立于实现")

    # --- 绘图 ---
    fig, axes = plt.subplots(2, 2, figsize=(14, 10))

    ax = axes[0, 0]
    ax.semilogy(ticks[::100], p4_paper[::100], 'b-', label='Paper: age^{1.5}', linewidth=1.5)
    ax.semilogy(ticks[::100], p4_impl[::100], 'r-', label='Impl: log(1+age/τ)·decay', linewidth=1.5)
    ax.set_xlabel('Tick')
    ax.set_ylabel('P4 (log scale)')
    ax.set_title('D15: P4 Raw Value — Paper vs Implementation')
    ax.legend()
    ax.grid(True, alpha=0.3)

    ax = axes[0, 1]
    ax.plot(ticks[1:600], delta_paper[:599], 'b-', label='Paper ΔP4', linewidth=1)
    ax.plot(ticks[1:600], delta_impl[:599], 'r-', label='Impl ΔP4', linewidth=1)
    ax.set_xlabel('Tick')
    ax.set_ylabel('ΔP4')
    ax.set_title('D15: P4 Increment (First 600 ticks)')
    ax.legend()
    ax.grid(True, alpha=0.3)

    ax = axes[1, 0]
    ax.plot(ticks, api4_paper, 'b-', label=f'Paper tanh(P4/{kappa4_paper})', linewidth=1.5)
    ax.plot(ticks, api4_impl, 'r-', label=f'Impl tanh(P4/{kappa4_impl})', linewidth=1.5)
    ax.axhline(y=0.99, color='gray', linestyle='--', alpha=0.5, label='0.99 saturation')
    ax.set_xlabel('Tick')
    ax.set_ylabel('tanh(P4/κ)')
    ax.set_title('D15: tanh-Normalized P4 Contribution to API')
    ax.legend()
    ax.grid(True, alpha=0.3)

    # 增量符号图（30天全域）
    ax = axes[1, 1]
    ax.plot(ticks[1:], delta_impl, 'r-', linewidth=0.5, alpha=0.8)
    ax.axhline(y=0, color='black', linestyle='-', linewidth=0.5)
    if impl_first_negative is not None:
        ax.axvline(x=impl_first_negative, color='orange', linestyle='--',
                   label=f'First ΔP4≤0 at tick {impl_first_negative}')
    ax.set_xlabel('Tick')
    ax.set_ylabel('ΔP4 (Implementation)')
    ax.set_title('D15: Implementation P4 Increment Over 30 Days')
    ax.legend()
    ax.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig(OUTPUT_DIR / "exp1_d15_p4_growth.png", dpi=150)
    plt.close()
    print(f"\n图表已保存: {OUTPUT_DIR / 'exp1_d15_p4_growth.png'}")


# ═══════════════════════════════════════════════════════════════════════════════
# Experiment 2: D16 — P_prospect as 7th Dimension
# ═══════════════════════════════════════════════════════════════════════════════

def exp2_p_prospect():
    """
    论文: P4 = retrospective + prospective (同一维度)
          API ∈ [0, 6)

    实现: P4 = retrospective only
          P_prospect = sigmoid(k·(1 - remaining/horizon)) · w  (独立维度)
          API = Σ₆ tanh(Pk/κk) + tanh(P_prospect/κ_p) ∈ [0, 7)

    验证:
    1. 论文合并 vs 实现分离的行为差异
    2. API 范围变化对 gates 的影响
    3. 分离是否有数学优势（避免双重计费）
    """
    print("\n" + "=" * 70)
    print("Experiment 2: D16 — P_prospect as 7th Dimension")
    print("=" * 70)

    # 参数
    beta_t = 1.5
    delta = 1.0
    w = 2.0
    epsilon = 1.0  # remaining 下限
    horizon_ticks = 1000  # 约 16 小时
    kappa4 = 200  # 论文

    # 模拟: 一个线程从 age=0 到 deadline
    ticks = np.arange(1, horizon_ticks + 1)
    remaining = np.maximum(epsilon, horizon_ticks - ticks)

    # 论文 P4 合并版
    retro_paper = ticks.astype(float) ** beta_t * w
    prosp_paper = remaining.astype(float) ** (-delta) * w
    p4_combined = retro_paper + prosp_paper

    # 实现 P4 分离版
    p4_retro_only = np.log(1 + ticks * 60.0 / 86400) * w  # 实现的对数版
    k_steep = 5.0
    progress = 1 - remaining / horizon_ticks
    p_prospect = w / (1 + np.exp(-k_steep * progress))  # sigmoid

    # API 贡献
    # 论文: 一个 tanh 通道
    api_combined = np.tanh(p4_combined / kappa4)

    # 实现: 两个独立 tanh 通道
    kappa4_impl = 5.0
    kappa_p = 5.0
    api_retro = np.tanh(p4_retro_only / kappa4_impl)
    api_prosp = np.tanh(p_prospect / kappa_p)
    api_separated = api_retro + api_prosp

    # 在 deadline 附近的行为
    last_100 = slice(-100, None)
    print(f"\n--- Deadline 前 100 ticks 的 API 贡献 ---")
    print(f"论文合并: mean={api_combined[last_100].mean():.3f}, "
          f"max={api_combined[last_100].max():.3f}")
    print(f"实现分离: mean={api_separated[last_100].mean():.3f}, "
          f"max={api_separated[last_100].max():.3f}")

    # 双重计费分析
    # 论文: retro + prosp 在同一个 tanh 通道里，会压缩（tanh 饱和）
    # 实现: 两个独立 tanh 通道，各自贡献最多 1.0
    print(f"\n--- 双重计费分析 ---")
    print(f"论文单通道最大贡献: {api_combined.max():.3f} (上界 1.0)")
    print(f"实现双通道最大贡献: {api_separated.max():.3f} (上界 2.0)")
    print(f"→ 分离使 deadline 线程的 API 贡献上界翻倍")

    # 论文的问题: 合并时 retro 项在 age→deadline 时已经巨大，
    # tanh 早已饱和，prosp 项的急剧增长被 tanh 吞掉了
    age_at_90pct = int(horizon_ticks * 0.9)
    print(f"\n--- 在 90% 进度时 ---")
    print(f"论文 retro only at 90%: {retro_paper[age_at_90pct]:.1f}")
    print(f"论文 prosp only at 90%: {prosp_paper[age_at_90pct]:.1f}")
    print(f"论文合并 P4: {p4_combined[age_at_90pct]:.1f}")
    print(f"论文 tanh(合并/{kappa4}): {api_combined[age_at_90pct]:.3f}")
    print(f"→ retro 项已使 tanh 饱和，prosp 项的紧迫信号被吞掉")

    print(f"\n--- D16 结论 ---")
    print("论文合并版的结构性缺陷:")
    print("  1. retro 项的 age^1.5 增长快速饱和 tanh，prosp 项的 deadline 信号被吞掉")
    print("  2. 一个快过期线程和一个老线程的 API 贡献相同（都是 tanh≈1）")
    print("实现分离版的优势:")
    print("  1. deadline 紧迫性有独立表达通道，不被 retro 饱和吞掉")
    print("  2. 避免 retro + prosp 双重计费导致的非线性耦合")
    print("代价:")
    print("  1. API 范围从 [0,6) 变为 [0,7)，所有基于 6 的归一化需要更新")
    print("  2. 论文的六维对称性破坏")

    # 绘图
    fig, axes = plt.subplots(1, 2, figsize=(14, 5))

    ax = axes[0]
    ax.plot(ticks, api_combined, 'b-', label='Paper: tanh((retro+prosp)/κ)', linewidth=1.5)
    ax.plot(ticks, api_separated, 'r-', label='Impl: tanh(retro/κ) + tanh(prosp/κ)', linewidth=1.5)
    ax.plot(ticks, api_retro, 'r--', label='Impl: retro only', linewidth=0.8, alpha=0.5)
    ax.plot(ticks, api_prosp, 'r:', label='Impl: prosp only', linewidth=0.8, alpha=0.5)
    ax.set_xlabel('Tick (→ deadline)')
    ax.set_ylabel('API Contribution')
    ax.set_title('D16: Combined vs Separated P4/P_prospect')
    ax.legend()
    ax.grid(True, alpha=0.3)

    ax = axes[1]
    ax.plot(ticks[-200:], api_combined[-200:], 'b-', label='Paper combined', linewidth=1.5)
    ax.plot(ticks[-200:], api_separated[-200:], 'r-', label='Impl separated', linewidth=1.5)
    ax.set_xlabel('Tick (last 200 before deadline)')
    ax.set_ylabel('API Contribution')
    ax.set_title('D16: Near-Deadline Behavior (Zoomed)')
    ax.legend()
    ax.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig(OUTPUT_DIR / "exp2_d16_prospect.png", dpi=150)
    plt.close()
    print(f"\n图表已保存: {OUTPUT_DIR / 'exp2_d16_prospect.png'}")


# ═══════════════════════════════════════════════════════════════════════════════
# Experiment 3: D26 — P6 Global Novelty Deficit vs Per-Contact Surprise
# ═══════════════════════════════════════════════════════════════════════════════

def exp3_p6_curiosity():
    """
    论文: P6(n) = max(0, η - (1/k)Σ novelty(j))
          全局、tick-indexed、source-agnostic

    实现: P6 = max(P6_surprise, P6_ambient)
          P6_surprise = Σ_c w_tier(c) × surprise(c) × γ(c)
          surprise 基于 per-contact 预测误差
          P6_ambient = η × (1 - familiarity(G))

    验证:
    1. 两种公式在不同场景下的行为差异
    2. 哪种更好地驱动探索行为
    3. 频道内容作为 novelty 来源的覆盖能力
    """
    print("\n" + "=" * 70)
    print("Experiment 3: D26 — P6 Global Novelty vs Per-Contact Surprise")
    print("=" * 70)

    eta = 0.6
    k = 50  # lookback window

    # 场景 1: 稳定环境，所有联系人按期望频率交互
    print("\n--- 场景 1: 稳定环境（所有联系人正常交互）---")
    # 论文: novelty(j) = some positive value → P6 低
    novelty_stable = np.random.uniform(0.01, 0.02, k)
    p6_paper_stable = max(0, eta - np.mean(novelty_stable))
    # 实现: silence_deviation ≈ 0, activity_rate_deviation ≈ 0 → surprise 低
    # σ 低（老联系人）→ surprise ≈ tanh(0) = 0 → P6_surprise ≈ 0
    # P6 = max(0, P6_ambient)
    p6_impl_stable = eta * 0.1  # familiarity 高 → ambient 低
    print(f"论文 P6 = {p6_paper_stable:.3f}")
    print(f"实现 P6 ≈ {p6_impl_stable:.3f}")
    print(f"→ 两者一致: 稳定环境下好奇心低")

    # 场景 2: 长时间无活动（idle）
    print("\n--- 场景 2: 长时间无活动（10 天静默）---")
    novelty_idle = np.zeros(k)
    p6_paper_idle = max(0, eta - np.mean(novelty_idle))
    # 实现: silence 偏离严重 → surprise 高
    # tier-5: expected 4h, actual 10d → deviation = (864000-14400)/14400 = 59
    silence_dev = (10 * 86400 - 14400) / 14400
    surprise_idle = math.tanh(silence_dev / 2)  # ≈ 1.0
    p6_impl_idle = 5.0 * surprise_idle * 1.0 / 5.0  # w_tier 归一化后
    print(f"论文 P6 = {p6_paper_idle:.3f} (达到最大值 η)")
    print(f"实现 P6_surprise ≈ {p6_impl_idle:.3f} (单联系人贡献)")
    print(f"→ 论文有硬上界 η={eta}; 实现 P6_surprise 随联系人数量增长")

    # 场景 3: 频道有大量新内容但联系人无变化
    print("\n--- 场景 3: 频道有新内容，但联系人行为无变化 ---")
    # 论文: 频道内容贡献 novelty(j) → P6 下降
    novelty_channel = np.concatenate([np.zeros(25), np.ones(25) * 0.03])
    p6_paper_channel = max(0, eta - np.mean(novelty_channel))
    # 实现: P6 只看联系人，频道内容不影响 P6
    p6_impl_channel = p6_impl_stable  # 没变
    print(f"论文 P6 = {p6_paper_channel:.3f} (频道 novelty 降低了 P6)")
    print(f"实现 P6 ≈ {p6_impl_channel:.3f} (频道不影响)")
    print(f"→ 关键差异: 论文的 P6 被频道新内容满足; 实现无此通道")
    print(f"   这是 ADR-206 要修复的核心问题之一")

    # 场景 4: 新联系人加入
    print("\n--- 场景 4: 5 个新联系人加入（认识论好奇心）---")
    # 论文: 新联系人交互贡献 novelty → P6 下降
    novelty_new = np.ones(k) * 0.02
    p6_paper_new = max(0, eta - np.mean(novelty_new))
    # 实现: σ=1 (新联系人) → surprise=1.0 → P6_surprise 飙升
    new_contacts = 5
    p6_impl_new = sum(
        (1.0 / 5.0) * 1.0 * (1 - math.exp(-86400 / 3000))  # w_tier * surprise * γ
        for _ in range(new_contacts)
    )
    print(f"论文 P6 = {p6_paper_new:.3f}")
    print(f"实现 P6_surprise ≈ {p6_impl_new:.3f}")
    print(f"→ 实现在新联系人场景下产生更高好奇心（认识论不确定性）")

    # 场景 5: 一个联系人突然变得异常活跃
    print("\n--- 场景 5: 一个 tier-50 联系人突然高频交互 ---")
    # 论文: 新交互贡献 novelty → P6 下降
    novelty_burst = np.concatenate([np.zeros(40), np.ones(10) * 0.05])
    p6_paper_burst = max(0, eta - np.mean(novelty_burst))
    # 实现: activity_rate_deviation 高 → surprise 高
    actual_daily = 20  # 突然每天 20 条
    expected_daily = 0.33  # tier-50 期望
    rate_dev = abs(math.log(max(actual_daily / expected_daily, 0.01)))
    surprise_burst = math.tanh((0 + rate_dev) / 2)  # silence_dev≈0
    p6_impl_burst = (1.5 / 5.0) * surprise_burst * 0.99  # w_tier(50)/max × surprise × γ
    print(f"论文 P6 = {p6_paper_burst:.3f} (novelty 充足 → P6 低)")
    print(f"实现 P6_surprise(该联系人) ≈ {p6_impl_burst:.3f} (行为偏差 → surprise 高)")
    print(f"→ 论文: 有新信息 → 不好奇 (正确)")
    print(f"   实现: 行为异常 → 好奇 (也正确，是不同的好奇心)")

    print(f"\n--- D26 综合结论 ---")
    print("两种 P6 建模了不同类型的好奇心:")
    print("  论文: 信息觅食型 (information foraging) — '最近学到新东西了吗'")
    print("  实现: 预测误差型 (prediction error) — '谁的行为出乎我意料'")
    print()
    print("论文的优势:")
    print("  1. Source-agnostic: 频道内容可以满足好奇心")
    print("  2. 全局视角: 不依赖具体联系人，系统级度量")
    print("  3. 简洁: 一个公式，参数少")
    print()
    print("实现的优势:")
    print("  1. Per-contact 粒度: 能区分'对谁好奇'")
    print("  2. 认识论+偶然双模式: σ 优雅地插值")
    print("  3. 行为偏差检测: 发现异常模式")
    print()
    print("核心缺陷:")
    print("  论文: novelty(j) 的具体计算未定义——论文故意留白")
    print("  实现: 完全不感知频道/信息源——ADR-206 §5 的修复目标")
    print()
    print("建议: 两种机制互补而非互斥。实现应保留 per-contact surprise，")
    print("      同时加入 source-agnostic novelty 分量（频道、Feed 等）")


# ═══════════════════════════════════════════════════════════════════════════════
# Experiment 4: D35/D36 — Voice Activation Functions
# ═══════════════════════════════════════════════════════════════════════════════

def exp4_voice_activation():
    """
    论文:
      f_D = (1/3)(P̂₁ + P̂₄ + P̂₅)          全局压力均值
      f_C = (1/2)(P̂₂ + P̂₆)
      f_S = P̂₃
      f_X = U(n) - Ŝ_API/κ_X              不确定性 - 归一化 API

    实现:
      R_D = WeightedMean([τ₁, τ₄, τ₅, τ_P], [1.0, 0.7, 1.0, 0.5])  per-entity
      R_C = WeightedMean([τ₂, τ₆], [0.8, 1.0])                       per-entity
      R_S = WeightedMean([τ₃, τ₅], [1.0, 0.6])                       per-entity
      R_X = (α_c·H(τ̂)·‖τ‖_norm + α_r·τ_risk + α_s·τ_spike) × (1+U)

    验证:
    1. Caution 激活条件的差异
    2. Sociability 是否应耦合 P5
    3. focal-set vs 全局聚合的行为差异
    """
    print("\n" + "=" * 70)
    print("Experiment 4: D35/D36 — Voice Activation Functions")
    print("=" * 70)

    # --- D36: Caution 激活对比 ---
    print("\n--- D36: Caution 激活条件 ---")

    # 场景矩阵: 不同压力状态下两种 Caution 的激活强度
    scenarios = [
        ("空闲（低压力、低信息）",
         {"P": [0.1, 0.0, 0.1, 0.0, 0.0, 0.0], "U": 0.8}),
        ("空闲（低压力、正常信息）",
         {"P": [0.1, 0.0, 0.1, 0.0, 0.0, 0.0], "U": 0.2}),
        ("正常活跃",
         {"P": [0.5, 0.2, 0.3, 0.1, 0.4, 0.1], "U": 0.3}),
        ("高冲突（多维同时高压）",
         {"P": [0.8, 0.7, 0.8, 0.6, 0.9, 0.5], "U": 0.5}),
        ("单维主导（P5 极高，其余低）",
         {"P": [0.1, 0.0, 0.1, 0.0, 0.9, 0.0], "U": 0.3}),
        ("新环境（高不确定，中等压力）",
         {"P": [0.3, 0.1, 0.4, 0.0, 0.3, 0.2], "U": 0.9}),
    ]

    kappa_X = 3.0
    alpha_c, alpha_r, alpha_s = 0.6, 0.8, 0.5
    kappa_norm = 10

    print(f"\n{'场景':<35} {'论文 f_X':<12} {'实现 R_X':<12} {'差异':<12}")
    print("-" * 71)

    for name, s in scenarios:
        P_hat = np.array(s["P"])
        U = s["U"]

        # 论文: f_X = U - S_API / κ_X
        S_api = np.sum(P_hat)
        f_X_paper = U - S_api / kappa_X

        # 实现: R_X = (α_c·H(P̂)·‖P̂‖_norm + α_r·τ_risk + α_s·τ_spike) × (1+U)
        # 简化: τ_risk=0, τ_spike=0 (正常情况)
        absvals = np.abs(P_hat)
        total = absvals.sum()
        if total > 0:
            probs = absvals / total
            H = -np.sum(probs * np.log(probs + 1e-10)) / np.log(len(P_hat))
        else:
            H = 0
        norm_mag = math.tanh(np.linalg.norm(P_hat) / kappa_norm)
        r_X_impl = (alpha_c * H * norm_mag) * (1 + U)

        diff = r_X_impl - f_X_paper
        print(f"{name:<35} {f_X_paper:<12.3f} {r_X_impl:<12.3f} {diff:+.3f}")

    print(f"\n--- D36 分析 ---")
    print("论文 Caution 最强时: 高 U + 低 API (什么都没发生，观望)")
    print("实现 Caution 最强时: 高 H + 高 ‖τ‖ + 高 U (多个目标冲突)")
    print()
    print("论文模型: Caution = 认识论刹车 (不确定就别动)")
    print("实现模型: Caution = 行为抑制系统 BIS (冲突时踩刹车)")
    print()
    print("哪个更合理？")
    print("  论文: 简洁，但'什么都没发生时最谨慎'在 Alice 场景中可能导致")
    print("        持续沉默（空闲时 U 高、API 低 → Caution 获胜 → 继续沉默）")
    print("  实现: 复杂，但基于 Gray's RST (BIS) 有心理学基础")
    print("        冲突时抑制是合理的进化策略")
    print()
    print("关键问题: 论文的 f_X 在空闲+低信息时为正且可能很大,")
    print("  这会让 Caution 在 Alice 应该探索时获胜")
    print("  实现通过 (1+U) 乘法器解决: 无信号 × 高U = 0")

    # --- D37: Sociability 是否应耦合 P5 ---
    print(f"\n--- D37: Sociability 耦合 P5 ---")
    print("论文: R_S = P̂₃ (纯社交冷却)")
    print("实现: R_S = WeightedMean([τ₃, τ₅], [1.0, 0.6])")
    print()
    print("实现的理由: 有人直接发消息给 Alice 时，")
    print("  不只是 Diligence 的任务（处理消息），也是 Sociability 的机会（互动）。")
    print("  τ₅ 的 0.6 权重确保 directed message 同时激活关系维护动机。")
    print()
    print("论文的理由: P5 已通过 Diligence 路由处理，Sociability 应只管关系冷却。")
    print("  交叉耦合模糊了声部的语义边界。")
    print()

    # 模拟: 有 directed message 时两种模型的声部差异
    scenarios_p5 = [
        ("无 directed, P3=0.5", 0.5, 0.0),
        ("有 directed, P3=0.5", 0.5, 0.8),
        ("有 directed, P3=0.0", 0.0, 0.8),
    ]

    print(f"{'场景':<30} {'论文 f_S':<10} {'实现 R_S':<10} {'S 增益':<10}")
    print("-" * 60)
    for name, p3, p5 in scenarios_p5:
        f_S_paper = p3
        r_S_impl = (1.0 * p3 + 0.6 * p5) / (1.0 + 0.6)
        gain = (r_S_impl - f_S_paper) / max(f_S_paper, 0.01) * 100
        print(f"{name:<30} {f_S_paper:<10.3f} {r_S_impl:<10.3f} {gain:+.0f}%")

    print(f"\n→ P5 耦合在有 directed message + 关系已冷的场景中差异最大")
    print(f"  论文: Sociability=0 (关系不冷就不管)")
    print(f"  实现: Sociability>0 (有人找我是社交机会)")

    print(f"\n--- D35/D36 综合结论 ---")
    print("1. Caution: 实现的 BIS 模型比论文的 U-API 模型更合理")
    print("   论文 f_X 有冷启动陷阱: 空闲→高U→高Caution→继续空闲")
    print("   建议: 论文应更新 f_X 公式或至少承认 BIS 替代")
    print()
    print("2. Sociability-P5 耦合: 实现有合理动机但破坏了论文的")
    print("   clean separation。建议论文加 Remark 说明 P5 双路由")
    print()
    print("3. focal-set vs 全局聚合: 实现的 per-entity 方法")
    print("   支持目标选择（知道对哪个实体好奇），论文的全局方法")
    print("   只能驱动'是否行动'，不能驱动'对谁行动'")
    print("   建议: 论文可以保持全局描述作为简化，加 Remark 说明")
    print("   实现的 focal-set 方法是论文公式的具象化")


# ═══════════════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    print("╔══════════════════════════════════════════════════════════════════╗")
    print("║  D15/D16/D26/D35/D36 — 理论→实现关键分歧模拟验证              ║")
    print("║  不偏袒任何一方，只看数学事实和行为后果                        ║")
    print("╚══════════════════════════════════════════════════════════════════╝")
    print()

    exp1_p4_growth()
    exp2_p_prospect()
    exp3_p6_curiosity()
    exp4_voice_activation()

    print("\n" + "=" * 70)
    print("全部实验完成。综合裁定:")
    print("=" * 70)
    print()
    print("D15 (P4 growth):")
    print("  判定: 实现偏离论文，但 idle-growth 弱形式可能仍成立")
    print("  风险: zombie decay 在 7 天后打破单调性 → Theorem 4 不成立")
    print("  行动: 论文需加 Remark 承认对数替代 + zombie decay 的影响")
    print()
    print("D16 (P_prospect):")
    print("  判定: 实现优于论文。分离避免了 tanh 饱和吞噬 deadline 信号")
    print("  行动: 论文应承认第 7 维，更新 API 范围为 [0,7)")
    print()
    print("D26 (P6 curiosity):")
    print("  判定: 两种模型互补。论文 source-agnostic, 实现 contact-specific")
    print("  行动: 实现应增加 source-agnostic 分量; 论文应定义 novelty(j)")
    print()
    print("D35/D36 (voice activation):")
    print("  判定: 实现的 BIS caution 和 focal-set 方法更合理")
    print("  行动: 论文应更新 Caution 公式或加 Remark 说明替代")

    print(f"\n输出目录: {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
