"""POMDP 信念更新模拟实验。

验证将五维闭环模型重新解释为 POMDP 的核心预测：
- Exp1: 信念准确度 vs 观测频率（稀疏观测 → 信念偏离）
- Exp2: 信念不确定性 → D5 保守行为（高熵 → 少行动）
- Exp3: 信息收集行动的价值（VoI 对高不确定联系人更高）
- Exp4: 信念衰减曲线（无观测 → 信念退化为先验）

理论依据：
- 五维论文 D0 图 G 是信念状态 b(s)，不是世界状态 s
- D4 Semantic Writeback 是概率信念更新（LLM 观测函数）
- D5 不行动包含信息收集行动（等待观测降低信念熵）
- runtime selfMoodDecay 实现了信念退化为先验

@see docs/adr/61-pomdp-belief-space-paper.md
"""
from __future__ import annotations

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import numpy as np
from scipy.stats import entropy as scipy_entropy
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


# ═══════════════════════════════════════════════════════════════════════════
# 核心组件：信念状态 + 真实状态 + 观测模型
# ═══════════════════════════════════════════════════════════════════════════

class TrueState:
    """联系人的真实状态（模拟用，Alice 不可见）。

    真实状态服从 Ornstein-Uhlenbeck 过程，模拟心情围绕基线波动：
        ds = θ(μ - s)dt + σ dW
    """

    def __init__(
        self,
        mood: float = 0.0,
        interest: float = 0.5,
        availability: float = 0.7,
        *,
        mood_mean: float = 0.0,
        mood_reversion: float = 0.05,
        mood_volatility: float = 0.1,
        rng: np.random.Generator | None = None,
    ):
        self.mood = mood                    # [-1, 1] 真实心情
        self.interest = interest            # [0, 1] 对 Alice 的真实兴趣
        self.availability = availability    # [0, 1] 真实可用性
        self.mood_mean = mood_mean
        self.mood_reversion = mood_reversion
        self.mood_volatility = mood_volatility
        self._rng = rng or np.random.default_rng()

    def evolve(self) -> None:
        """单步 OU 过程演化。"""
        # mood: OU 过程
        self.mood += self.mood_reversion * (self.mood_mean - self.mood)
        self.mood += self.mood_volatility * self._rng.standard_normal()
        self.mood = float(np.clip(self.mood, -1.0, 1.0))
        # interest: 缓慢漂移
        self.interest += 0.01 * self._rng.standard_normal()
        self.interest = float(np.clip(self.interest, 0.0, 1.0))
        # availability: 随机切换
        if self._rng.random() < 0.05:
            self.availability = float(self._rng.uniform(0.2, 1.0))

    def generate_observation(self, noise_std: float = 0.2) -> dict[str, float]:
        """从真实状态生成带噪声的观测（模拟 LLM 语义提取）。

        对应五维论文 D4 Semantic Writeback：
        LLM 从消息文本中提取 mood 等信念属性，带有观测噪声。
        """
        obs_mood = self.mood + noise_std * self._rng.standard_normal()
        obs_mood = float(np.clip(obs_mood, -1.0, 1.0))
        obs_interest = self.interest + noise_std * 0.5 * self._rng.standard_normal()
        obs_interest = float(np.clip(obs_interest, 0.0, 1.0))
        return {"mood": obs_mood, "interest": obs_interest}

    def message_probability(self) -> float:
        """联系人在本 tick 发送消息的概率。

        取决于 availability 和 interest，模拟稀疏观测。
        """
        base_rate = 0.05  # 每 tick 5% 基础消息率
        return base_rate * self.availability * (0.5 + 0.5 * self.interest)


class BeliefState:
    """Alice 对联系人状态的信念（高斯近似）。

    每个属性存储为 (mean, variance)，对应 POMDP 的信念分布 b(s)。
    当前五维论文 D0 图 G 只存点估计——这里扩展为分布。

    @see five-dim-pomdp-mapping.md §5.3 "无置信度追踪"
    """

    def __init__(
        self,
        mood_mean: float = 0.0,
        mood_var: float = 0.25,  # 初始方差
        interest_mean: float = 0.5,
        interest_var: float = 0.1,
        *,
        prior_mood_mean: float = 0.0,
        prior_mood_var: float = 0.25,
        prior_interest_mean: float = 0.5,
        prior_interest_var: float = 0.1,
    ):
        self.mood_mean = mood_mean
        self.mood_var = mood_var
        self.interest_mean = interest_mean
        self.interest_var = interest_var
        # 先验参数（信念衰减的目标）——独立于初始值
        self._prior_mood_mean = prior_mood_mean
        self._prior_mood_var = prior_mood_var
        self._prior_interest_mean = prior_interest_mean
        self._prior_interest_var = prior_interest_var

    def predict(self, process_noise: float = 0.01) -> None:
        """卡尔曼预测步：加入过程噪声（真实状态在漂移）。

        σ²_predict = σ²_prior + Q
        对应 OU 过程的状态变化不确定性。
        """
        self.mood_var = min(self.mood_var + process_noise, self._prior_mood_var)
        self.interest_var = min(self.interest_var + process_noise * 0.5,
                                self._prior_interest_var)

    def update(
        self,
        observation: dict[str, float],
        obs_noise_var: float = 0.04,
    ) -> None:
        """贝叶斯信念更新（高斯-高斯共轭）。

        后验 = 先验 × 似然：
        μ' = (σ²_obs · μ + σ²_prior · z) / (σ²_obs + σ²_prior)
        σ'² = (σ²_obs · σ²_prior) / (σ²_obs + σ²_prior)

        对应五维论文 D4 的 Semantic Writeback + EMA 平滑。
        runtime 的 SELF_MOOD_ALPHA=0.3 是此更新的线性近似。
        """
        if "mood" in observation:
            z = observation["mood"]
            # 卡尔曼增益
            k = self.mood_var / (self.mood_var + obs_noise_var)
            self.mood_mean = self.mood_mean + k * (z - self.mood_mean)
            self.mood_var = (1 - k) * self.mood_var

        if "interest" in observation:
            z = observation["interest"]
            k = self.interest_var / (self.interest_var + obs_noise_var)
            self.interest_mean = self.interest_mean + k * (z - self.interest_mean)
            self.interest_var = (1 - k) * self.interest_var

    def decay(self, decay_rate: float = 0.01) -> None:
        """无观测时信念退化为先验。

        对应 runtime selfMoodDecay: mood_eff = mood × 0.5^(t/halfLife)
        这里用方差膨胀实现等价效果：σ² → σ² + decay_rate × (σ²_prior - σ²)

        均值也向先验回归：μ → μ + decay_rate × (μ_prior - μ)
        """
        self.mood_mean += decay_rate * (self._prior_mood_mean - self.mood_mean)
        self.mood_var += decay_rate * (self._prior_mood_var - self.mood_var)
        self.mood_var = min(self.mood_var, self._prior_mood_var)  # 不超过先验

        self.interest_mean += decay_rate * (self._prior_interest_mean - self.interest_mean)
        self.interest_var += decay_rate * (self._prior_interest_var - self.interest_var)
        self.interest_var = min(self.interest_var, self._prior_interest_var)

    def uncertainty(self) -> float:
        """信念不确定性（总方差）。

        U = σ²_mood + σ²_interest
        高 U = 高不确定性 → D5 应倾向保守。

        使用总方差而非高斯熵，因为高斯熵在小方差时为负。
        总方差 ∈ [0, prior_var_sum]，语义清晰。
        """
        return float(self.mood_var + self.interest_var)

    def entropy(self) -> float:
        """信念熵（高斯熵的和）。

        H = 0.5 * ln(2πe σ²) 对每个维度。
        注意：高斯熵在 σ² < 1/(2πe) ≈ 0.058 时为负。
        """
        h_mood = 0.5 * np.log(2 * np.pi * np.e * max(self.mood_var, 1e-10))
        h_interest = 0.5 * np.log(2 * np.pi * np.e * max(self.interest_var, 1e-10))
        return float(h_mood + h_interest)

    def mse(self, true_state: TrueState) -> float:
        """信念均方误差 E[(estimate - true)²]。"""
        return float(
            (self.mood_mean - true_state.mood) ** 2
            + (self.interest_mean - true_state.interest) ** 2
        )


class SocialPOMDP:
    """社交 POMDP 整合器。

    将 BeliefState、TrueState 和压力引擎组合，
    实现不确定性感知的行动决策。

    对应五维论文 D5 Net Social Value + 信念不确定性惩罚：
    V_uncertain(a, n) = V(a, n) - β · H(b_contact)
    """

    def __init__(
        self,
        n_contacts: int = 10,
        beta_uncertainty: float = 0.3,
        seed: int = 42,
    ):
        self.rng = np.random.default_rng(seed)
        self.n_contacts = n_contacts
        self.beta_uncertainty = beta_uncertainty

        # 初始化联系人
        self.true_states: list[TrueState] = []
        self.beliefs: list[BeliefState] = []
        self.tiers: list[int] = []

        tier_pool = [5, 15, 50, 150, 500]
        tier_probs = np.array([0.05, 0.1, 0.25, 0.35, 0.25])
        tier_probs /= tier_probs.sum()

        for _ in range(n_contacts):
            tier = int(self.rng.choice(tier_pool, p=tier_probs))
            mood_init = float(self.rng.uniform(-0.5, 0.5))
            interest_init = float(self.rng.uniform(0.3, 0.8))

            self.true_states.append(TrueState(
                mood=mood_init,
                interest=interest_init,
                mood_mean=mood_init,
                rng=self.rng,
            ))
            self.beliefs.append(BeliefState(
                mood_mean=0.0,       # 初始信念 = 先验（不知道真实状态）
                mood_var=0.25,
                interest_mean=0.5,
                interest_var=0.1,
            ))
            self.tiers.append(tier)

    def compute_action_value(
        self,
        contact_idx: int,
        use_uncertainty_penalty: bool = True,
    ) -> float:
        """计算对联系人行动的净社交价值。

        V(a, c) = base_value - β · H(b_c)

        base_value 基于压力（P3 关系冷却的简化版）。
        不确定性惩罚 β·H 使 Alice 在信念不确定时保守。
        """
        belief = self.beliefs[contact_idx]
        tier = self.tiers[contact_idx]

        # 基于 tier 的基础行动价值（越亲密，行动价值越高）
        tier_weight = {5: 5.0, 15: 3.0, 50: 1.5, 150: 0.8, 500: 0.3}.get(tier, 0.8)

        # 基于信念的 mood 调制（心情越差，行动价值越高——去关心）
        mood_urgency = max(0.0, -belief.mood_mean)  # 负心情 → 更需要关心

        base_value = tier_weight * (0.3 + 0.7 * mood_urgency)

        if use_uncertainty_penalty:
            penalty = self.beta_uncertainty * belief.uncertainty()
            return base_value - penalty
        return base_value

    def compute_greeting_voi(self, contact_idx: int) -> float:
        """计算问候消息的信息价值 (Value of Information)。

        VoI = 信念更新带来的不确定性降低（方差减少量）。
        高不确定性联系人 → 高 VoI（问候能获得更多信息）。

        对应 InfoSeeker (Fang & Ke, 2025) 的信息收集行动。
        """
        belief = self.beliefs[contact_idx]
        current_uncertainty = belief.uncertainty()

        # 模拟：问候后获得观测，信念更新后的预期不确定性
        obs_noise_var = 0.04
        expected_mood_var = (belief.mood_var * obs_noise_var) / (belief.mood_var + obs_noise_var)
        expected_interest_var = (belief.interest_var * obs_noise_var) / (belief.interest_var + obs_noise_var)

        expected_uncertainty = expected_mood_var + expected_interest_var

        return float(current_uncertainty - expected_uncertainty)


# ═══════════════════════════════════════════════════════════════════════════
# Exp1: 信念准确度 vs 观测频率
# ═══════════════════════════════════════════════════════════════════════════

def run_exp1(
    n_trials: int = 50,
    n_steps: int = 200,
    seed_base: int = 10000,
) -> dict:
    """模拟不同消息频率下的信念准确度。

    高活跃联系人 → 频繁观测 → 低 MSE
    低活跃联系人 → 稀疏观测 → 高 MSE

    对应五维论文 D4 Semantic Writeback 的信噪比分析。
    """
    print("\n  Exp1: 信念准确度 vs 观测频率")

    # 不同观测间隔（每 N tick 一次观测）
    obs_intervals = [1, 2, 5, 10, 20, 50, 100]
    n_intervals = len(obs_intervals)

    mse_matrix = np.zeros((n_trials, n_intervals, n_steps))  # [trial, interval, step]
    entropy_matrix = np.zeros((n_trials, n_intervals, n_steps))

    for trial in range(n_trials):
        rng = np.random.default_rng(seed_base + trial)

        for ii, interval in enumerate(obs_intervals):
            true = TrueState(
                mood=float(rng.uniform(-0.5, 0.5)),
                interest=float(rng.uniform(0.3, 0.8)),
                mood_mean=0.0,
                mood_volatility=0.1,
                rng=np.random.default_rng(seed_base + trial),  # 同真实状态
            )
            belief = BeliefState()

            for step in range(n_steps):
                true.evolve()

                # 卡尔曼预测步：每 tick 加入过程噪声
                belief.predict(process_noise=0.005)

                if (step + 1) % interval == 0:
                    obs = true.generate_observation(noise_std=0.2)
                    belief.update(obs, obs_noise_var=0.04)
                else:
                    belief.decay(decay_rate=0.01)

                mse_matrix[trial, ii, step] = belief.mse(true)
                entropy_matrix[trial, ii, step] = belief.uncertainty()

    # 汇总：每个间隔的平均 MSE 和熵（最后 50 步的稳态值）
    steady_start = max(0, n_steps - 50)
    mean_mse_per_interval = mse_matrix[:, :, steady_start:].mean(axis=(0, 2))
    std_mse_per_interval = mse_matrix[:, :, steady_start:].mean(axis=2).std(axis=0)
    mean_entropy_per_interval = entropy_matrix[:, :, steady_start:].mean(axis=(0, 2))

    # 全时间轴轨迹（取两个代表性间隔）
    mse_trace_fast = mse_matrix[:, 0, :].mean(axis=0)    # interval=1
    mse_trace_slow = mse_matrix[:, -2, :].mean(axis=0)   # interval=50

    result = {
        "obs_intervals": obs_intervals,
        "mean_mse": mean_mse_per_interval,
        "std_mse": std_mse_per_interval,
        "mean_entropy": mean_entropy_per_interval,
        "mse_trace_fast": mse_trace_fast,
        "mse_trace_slow": mse_trace_slow,
        "mse_matrix": mse_matrix,
    }

    print(f"    观测间隔 → 稳态 MSE:")
    for iv, mse_val in zip(obs_intervals, mean_mse_per_interval):
        print(f"      interval={iv:3d}  MSE={mse_val:.4f}")

    return result


def plot_exp1(results: dict, output_path: str) -> None:
    """Exp1 图表：MSE vs 观测间隔 + 时间轨迹。"""
    fig, axes = plt.subplots(1, 2, figsize=(10, 4))

    # (a) MSE vs observation interval
    ax = axes[0]
    intervals = results["obs_intervals"]
    mse_vals = results["mean_mse"]
    mse_stds = results["std_mse"]

    ax.errorbar(intervals, mse_vals, yerr=mse_stds,
                marker="o", color="#1565c0", capsize=3, linewidth=1.5)
    ax.set_xlabel("Observation interval (ticks)")
    ax.set_ylabel("Steady-state belief MSE")
    ax.set_xscale("log")
    ax.set_title("(a) Belief accuracy vs observation frequency")
    ax.grid(True, alpha=0.3)

    # 标注：annotation
    ax.annotate("High activity\n(frequent obs.)",
                xy=(1, mse_vals[0]), fontsize=7, color="#2e7d32",
                xytext=(3, mse_vals[0] + 0.05),
                arrowprops=dict(arrowstyle="->", color="#2e7d32"))
    ax.annotate("Low activity\n(sparse obs.)",
                xy=(intervals[-2], mse_vals[-2]), fontsize=7, color="#c62828",
                xytext=(intervals[-2] * 0.3, mse_vals[-2] + 0.03),
                arrowprops=dict(arrowstyle="->", color="#c62828"))

    # (b) MSE 时间轨迹对比
    ax = axes[1]
    x = np.arange(1, len(results["mse_trace_fast"]) + 1)
    ax.plot(x, results["mse_trace_fast"], color="#2e7d32", linewidth=1.2,
            label=f"interval=1 (high activity)")
    ax.plot(x, results["mse_trace_slow"], color="#c62828", linewidth=1.2,
            label=f"interval=50 (low activity)")
    ax.set_xlabel("Tick")
    ax.set_ylabel("Belief MSE")
    ax.set_title("(b) Belief MSE over time")
    ax.legend(fontsize=8)
    ax.grid(True, alpha=0.3)

    fig.tight_layout()
    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"    图已保存: {output_path}")


# ═══════════════════════════════════════════════════════════════════════════
# Exp2: 信念不确定性 → D5 保守行为
# ═══════════════════════════════════════════════════════════════════════════

def run_exp2(
    n_trials: int = 50,
    n_steps: int = 300,
    seed_base: int = 20000,
) -> dict:
    """验证不确定性惩罚项使高熵时行动频率下降。

    V_uncertain(a, n) = V(a, n) - β · H(b_contact)

    对比有 vs 无不确定性惩罚的行为差异：
    - 有惩罚：高不确定性 → 保守（沉默增加）
    - 无惩罚：不区分确定性高低，行动频率恒定

    对应五维论文 D5 "silence as unstable readiness"。
    """
    print("\n  Exp2: 信念不确定性 → D5 保守行为")

    action_threshold = 1.0  # V > threshold 时行动

    # 收集结果
    actions_with_penalty: list[int] = []
    actions_without_penalty: list[int] = []
    entropy_at_action_wp: list[float] = []
    entropy_at_action_np: list[float] = []
    entropy_at_silence_wp: list[float] = []

    # 每个 trial 的时间序列（取一个代表性 trial）
    trace_actions_wp: list[bool] = []
    trace_actions_np: list[bool] = []
    trace_entropy: list[float] = []
    trace_value_wp: list[float] = []
    trace_value_np: list[float] = []

    for trial in range(n_trials):
        pomdp = SocialPOMDP(n_contacts=10, beta_uncertainty=0.5,
                            seed=seed_base + trial)

        trial_actions_wp = 0
        trial_actions_np = 0

        for step in range(n_steps):
            # 演化所有联系人的真实状态
            for ts in pomdp.true_states:
                ts.evolve()

            # 随机一部分联系人发消息（观测）
            for ci in range(pomdp.n_contacts):
                pomdp.beliefs[ci].predict(process_noise=0.005)
                msg_prob = pomdp.true_states[ci].message_probability()
                if pomdp.rng.random() < msg_prob:
                    obs = pomdp.true_states[ci].generate_observation()
                    pomdp.beliefs[ci].update(obs)
                else:
                    pomdp.beliefs[ci].decay()

            # 选择最高价值的行动目标
            values_wp = [pomdp.compute_action_value(ci, use_uncertainty_penalty=True)
                         for ci in range(pomdp.n_contacts)]
            values_np = [pomdp.compute_action_value(ci, use_uncertainty_penalty=False)
                         for ci in range(pomdp.n_contacts)]

            best_wp = max(values_wp)
            best_np = max(values_np)
            best_idx = int(np.argmax(values_wp))
            contact_entropy = pomdp.beliefs[best_idx].uncertainty()

            act_wp = best_wp > action_threshold
            act_np = best_np > action_threshold

            if act_wp:
                trial_actions_wp += 1
                entropy_at_action_wp.append(contact_entropy)
            else:
                entropy_at_silence_wp.append(contact_entropy)

            if act_np:
                trial_actions_np += 1
                entropy_at_action_np.append(contact_entropy)

            # 记录第一个 trial 的详细轨迹
            if trial == 0:
                trace_actions_wp.append(act_wp)
                trace_actions_np.append(act_np)
                trace_entropy.append(contact_entropy)
                trace_value_wp.append(best_wp)
                trace_value_np.append(best_np)

        actions_with_penalty.append(trial_actions_wp)
        actions_without_penalty.append(trial_actions_np)

    result = {
        "mean_actions_wp": float(np.mean(actions_with_penalty)),
        "mean_actions_np": float(np.mean(actions_without_penalty)),
        "std_actions_wp": float(np.std(actions_with_penalty)),
        "std_actions_np": float(np.std(actions_without_penalty)),
        "action_reduction_pct": float(
            (np.mean(actions_without_penalty) - np.mean(actions_with_penalty))
            / max(np.mean(actions_without_penalty), 1) * 100
        ),
        "mean_entropy_at_action": float(np.mean(entropy_at_action_wp)) if entropy_at_action_wp else 0.0,
        "mean_entropy_at_silence": float(np.mean(entropy_at_silence_wp)) if entropy_at_silence_wp else 0.0,
        "trace_actions_wp": trace_actions_wp,
        "trace_actions_np": trace_actions_np,
        "trace_entropy": trace_entropy,
        "trace_value_wp": trace_value_wp,
        "trace_value_np": trace_value_np,
        "actions_with_penalty": actions_with_penalty,
        "actions_without_penalty": actions_without_penalty,
    }

    print(f"    有不确定性惩罚: {result['mean_actions_wp']:.1f} ± {result['std_actions_wp']:.1f} 次行动")
    print(f"    无不确定性惩罚: {result['mean_actions_np']:.1f} ± {result['std_actions_np']:.1f} 次行动")
    print(f"    行动减少: {result['action_reduction_pct']:.1f}%")
    print(f"    行动时信念熵: {result['mean_entropy_at_action']:.3f}")
    print(f"    沉默时信念熵: {result['mean_entropy_at_silence']:.3f}")

    return result


def plot_exp2(results: dict, output_path: str) -> None:
    """Exp2 图表：有/无惩罚的行动频率对比 + 熵-价值关系。"""
    fig, axes = plt.subplots(1, 2, figsize=(10, 4))

    # (a) 行动频率对比（箱线图）
    ax = axes[0]
    data = [results["actions_with_penalty"], results["actions_without_penalty"]]
    bp = ax.boxplot(data, tick_labels=["With uncertainty\npenalty", "Without\npenalty"],
                    patch_artist=True)
    bp["boxes"][0].set_facecolor("#2e7d32")
    bp["boxes"][0].set_alpha(0.4)
    bp["boxes"][1].set_facecolor("#c62828")
    bp["boxes"][1].set_alpha(0.4)
    ax.set_ylabel("Number of actions (per 300 ticks)")
    ax.set_title("(a) Action frequency: with vs without\nuncertainty penalty")
    ax.grid(True, alpha=0.3, axis="y")

    reduction = results["action_reduction_pct"]
    ax.text(0.95, 0.95, f"Reduction: {reduction:.1f}%",
            transform=ax.transAxes, fontsize=9, ha="right", va="top",
            bbox=dict(boxstyle="round,pad=0.3", facecolor="wheat", alpha=0.5))

    # (b) Value 轨迹 + entropy
    ax = axes[1]
    n = len(results["trace_value_wp"])
    x = np.arange(1, n + 1)

    ax.plot(x, results["trace_value_wp"], color="#2e7d32", linewidth=0.8,
            alpha=0.8, label="V with penalty")
    ax.plot(x, results["trace_value_np"], color="#c62828", linewidth=0.8,
            alpha=0.8, label="V without penalty")
    ax.axhline(1.0, color="#666", linewidth=0.5, linestyle=":", label="Action threshold")

    ax2 = ax.twinx()
    ax2.plot(x, results["trace_entropy"], color="#f57c00", linewidth=0.6,
             alpha=0.6, label="Belief entropy")
    ax2.set_ylabel("Belief entropy H(b)", color="#f57c00")
    ax2.tick_params(axis="y", labelcolor="#f57c00")

    ax.set_xlabel("Tick")
    ax.set_ylabel("Action value V")
    ax.set_title("(b) Action value trace (single trial)")
    ax.legend(loc="upper left", fontsize=7)
    ax2.legend(loc="upper right", fontsize=7)
    ax.grid(True, alpha=0.3)

    fig.tight_layout()
    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"    图已保存: {output_path}")


# ═══════════════════════════════════════════════════════════════════════════
# Exp3: 信息收集行动的价值 (Value of Information)
# ═══════════════════════════════════════════════════════════════════════════

def run_exp3(
    n_trials: int = 50,
    n_steps: int = 200,
    seed_base: int = 30000,
) -> dict:
    """模拟问候消息的信息价值。

    VoI = 信念更新带来的熵降低。
    预测：对不确定性高的联系人，问候的 VoI 更高。

    对应五维论文 D5 的信息论解释 +
    InfoSeeker (Fang & Ke, 2025) 的信息收集行动框架。
    """
    print("\n  Exp3: 信息收集行动的价值 (VoI)")

    # 收集每个联系人在不同时刻的 (uncertainty, VoI) 对
    uncertainty_voi_pairs: list[tuple[float, float]] = []

    # VoI 随时间的变化（取单个 trial 的单个联系人）
    voi_trace: list[float] = []
    uncertainty_trace: list[float] = []

    # 按 tier 分组的 VoI
    tier_voi: dict[int, list[float]] = {5: [], 15: [], 50: [], 150: [], 500: []}

    for trial in range(n_trials):
        pomdp = SocialPOMDP(n_contacts=10, seed=seed_base + trial)

        for step in range(n_steps):
            # 演化
            for ts in pomdp.true_states:
                ts.evolve()

            # 随机观测
            for ci in range(pomdp.n_contacts):
                pomdp.beliefs[ci].predict(process_noise=0.005)
                msg_prob = pomdp.true_states[ci].message_probability()
                if pomdp.rng.random() < msg_prob:
                    obs = pomdp.true_states[ci].generate_observation()
                    pomdp.beliefs[ci].update(obs)
                else:
                    pomdp.beliefs[ci].decay()

            # 计算每个联系人的 VoI
            for ci in range(pomdp.n_contacts):
                unc = pomdp.beliefs[ci].uncertainty()
                voi = pomdp.compute_greeting_voi(ci)
                uncertainty_voi_pairs.append((unc, voi))
                tier_voi[pomdp.tiers[ci]].append(voi)

            # 详细轨迹（第一个 trial，联系人 0）
            if trial == 0:
                voi_trace.append(pomdp.compute_greeting_voi(0))
                uncertainty_trace.append(pomdp.beliefs[0].uncertainty())

    # 构建 uncertainty → VoI 的分箱统计
    all_unc = np.array([p[0] for p in uncertainty_voi_pairs])
    all_voi = np.array([p[1] for p in uncertainty_voi_pairs])

    n_bins = 10
    unc_bins = np.linspace(all_unc.min(), all_unc.max(), n_bins + 1)
    binned_voi_mean = []
    binned_voi_std = []
    bin_centers = []

    for i in range(n_bins):
        mask = (all_unc >= unc_bins[i]) & (all_unc < unc_bins[i + 1])
        if mask.sum() > 0:
            binned_voi_mean.append(float(all_voi[mask].mean()))
            binned_voi_std.append(float(all_voi[mask].std()))
            bin_centers.append(float((unc_bins[i] + unc_bins[i + 1]) / 2))

    # tier 级 VoI 统计
    tier_mean_voi = {t: float(np.mean(vs)) if vs else 0.0 for t, vs in tier_voi.items()}

    result = {
        "bin_centers": bin_centers,
        "binned_voi_mean": binned_voi_mean,
        "binned_voi_std": binned_voi_std,
        "voi_trace": voi_trace,
        "uncertainty_trace": uncertainty_trace,
        "tier_mean_voi": tier_mean_voi,
        "all_uncertainty": all_unc,
        "all_voi": all_voi,
    }

    print(f"    Uncertainty → VoI 正相关: {np.corrcoef(all_unc, all_voi)[0, 1]:.3f}")
    print(f"    按 tier 的平均 VoI:")
    for tier in sorted(tier_mean_voi.keys()):
        print(f"      tier={tier:3d}  VoI={tier_mean_voi[tier]:.4f}")

    return result


def plot_exp3(results: dict, output_path: str) -> None:
    """Exp3 图表：VoI vs uncertainty + tier 对比。"""
    fig, axes = plt.subplots(1, 2, figsize=(10, 4))

    # (a) Uncertainty → VoI 关系
    ax = axes[0]

    # 散点（采样，避免太密）
    n_sample = min(5000, len(results["all_uncertainty"]))
    idx = np.random.default_rng(42).choice(len(results["all_uncertainty"]),
                                           size=n_sample, replace=False)
    ax.scatter(results["all_uncertainty"][idx], results["all_voi"][idx],
               s=3, alpha=0.15, color="#666")

    # 分箱均值
    ax.errorbar(results["bin_centers"], results["binned_voi_mean"],
                yerr=results["binned_voi_std"],
                marker="s", color="#1565c0", capsize=3, linewidth=1.5,
                label="Binned mean ± std", zorder=5)

    ax.set_xlabel("Belief uncertainty $\\sigma^2_{mood} + \\sigma^2_{interest}$")
    ax.set_ylabel("Value of Information (VoI)")
    ax.set_title("(a) VoI increases with belief uncertainty")
    ax.legend(fontsize=8)
    ax.grid(True, alpha=0.3)

    # 相关系数标注
    corr = np.corrcoef(results["all_uncertainty"], results["all_voi"])[0, 1]
    ax.text(0.05, 0.95, f"r = {corr:.3f}",
            transform=ax.transAxes, fontsize=9, va="top",
            bbox=dict(boxstyle="round,pad=0.3", facecolor="lightyellow", alpha=0.8))

    # (b) 按 Dunbar tier 的 VoI 对比
    ax = axes[1]
    tiers = sorted(results["tier_mean_voi"].keys())
    voi_vals = [results["tier_mean_voi"][t] for t in tiers]
    colors = ["#1a237e", "#1565c0", "#42a5f5", "#90caf9", "#bbdefb"]

    bars = ax.bar([str(t) for t in tiers], voi_vals, color=colors)
    ax.set_xlabel("Dunbar tier")
    ax.set_ylabel("Mean VoI")
    ax.set_title("(b) VoI by relationship tier")
    ax.grid(True, alpha=0.3, axis="y")

    # 标注数值
    for bar, val in zip(bars, voi_vals):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.001,
                f"{val:.3f}", ha="center", va="bottom", fontsize=8)

    fig.tight_layout()
    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"    图已保存: {output_path}")


# ═══════════════════════════════════════════════════════════════════════════
# Exp4: 信念衰减曲线
# ═══════════════════════════════════════════════════════════════════════════

def run_exp4(
    n_trials: int = 50,
    n_steps: int = 200,
    decay_rates: list[float] | None = None,
    seed_base: int = 40000,
) -> dict:
    """联系人停止发消息后，信念退化为先验。

    模拟不同半衰期的信念衰减：
    - 方差：σ² → σ²_prior（不确定性增加）
    - 均值：μ → μ_prior（忘记观测到的状态）

    对应 runtime selfMoodDecay: mood_eff = mood × 0.5^(t/halfLife)

    验证：衰减曲线的形状与 exp(-t/τ) 一致。
    """
    print("\n  Exp4: 信念衰减曲线")

    if decay_rates is None:
        decay_rates = [0.005, 0.01, 0.02, 0.05, 0.1]

    n_rates = len(decay_rates)

    # 信念熵随时间的变化（从精确信念开始，停止观测）
    entropy_curves = np.zeros((n_trials, n_rates, n_steps))
    mood_mean_curves = np.zeros((n_trials, n_rates, n_steps))
    mood_var_curves = np.zeros((n_trials, n_rates, n_steps))

    for trial in range(n_trials):
        rng = np.random.default_rng(seed_base + trial)

        for ri, decay_rate in enumerate(decay_rates):
            # 初始化：精确信念（刚观测过），先验方差设为 0.25
            true_mood = float(rng.uniform(-0.8, 0.8))
            belief = BeliefState(
                mood_mean=true_mood,
                mood_var=0.01,          # 低方差 = 高置信
                interest_mean=0.6,
                interest_var=0.02,
                prior_mood_var=0.25,    # 无信息先验
                prior_interest_var=0.1,
            )
            # 真实状态继续演化，但 Alice 不再观测
            true = TrueState(
                mood=true_mood,
                mood_mean=0.0,
                mood_volatility=0.1,
                rng=np.random.default_rng(seed_base + trial),
            )

            for step in range(n_steps):
                true.evolve()                   # 真实状态变化
                belief.predict(process_noise=decay_rate * 0.5)  # 过程噪声
                belief.decay(decay_rate)        # 信念衰减（无观测）

                entropy_curves[trial, ri, step] = belief.uncertainty()
                mood_mean_curves[trial, ri, step] = belief.mood_mean
                mood_var_curves[trial, ri, step] = belief.mood_var

    # 计算平均曲线
    mean_entropy = entropy_curves.mean(axis=0)  # (n_rates, n_steps)
    mean_mood_var = mood_var_curves.mean(axis=0)

    # 计算等效半衰期（方差达到初始值与先验中点的时间）
    half_life_ticks = []
    prior_var = 0.25
    init_var = 0.01
    target = init_var + 0.5 * (prior_var - init_var)  # 0.13
    for ri in range(n_rates):
        var_curve = mean_mood_var[ri, :]
        # 找第一个 >= target 的索引
        exceeded = np.where(var_curve >= target)[0]
        if len(exceeded) > 0:
            half_life_ticks.append(int(exceeded[0]) + 1)
        else:
            half_life_ticks.append(n_steps)

    result = {
        "decay_rates": decay_rates,
        "mean_entropy": mean_entropy,
        "mean_mood_var": mean_mood_var,
        "half_life_ticks": half_life_ticks,
        "entropy_curves": entropy_curves,
    }

    print(f"    衰减率 → 半衰期:")
    for dr, hl in zip(decay_rates, half_life_ticks):
        print(f"      decay_rate={dr:.3f}  half_life={hl} ticks")

    return result


def plot_exp4(results: dict, output_path: str) -> None:
    """Exp4 图表：信念熵衰减曲线。"""
    fig, axes = plt.subplots(1, 2, figsize=(10, 4))

    decay_rates = results["decay_rates"]
    n_steps = results["mean_entropy"].shape[1]
    x = np.arange(1, n_steps + 1)

    # 色彩映射
    cmap = plt.cm.viridis
    colors = [cmap(i / (len(decay_rates) - 1)) for i in range(len(decay_rates))]

    # (a) 信念熵 vs 无观测时间
    ax = axes[0]
    for ri, (dr, color) in enumerate(zip(decay_rates, colors)):
        ax.plot(x, results["mean_entropy"][ri, :], color=color, linewidth=1.3,
                label=f"$\\lambda$={dr}")

    ax.set_xlabel("Ticks without observation")
    ax.set_ylabel("Belief entropy H(b)")
    ax.set_title("(a) Belief entropy growth\nwithout observation")
    ax.legend(fontsize=7, title="Decay rate", title_fontsize=7)
    ax.grid(True, alpha=0.3)

    # (b) 信念方差 vs 无观测时间
    ax = axes[1]
    for ri, (dr, color) in enumerate(zip(decay_rates, colors)):
        ax.plot(x, results["mean_mood_var"][ri, :], color=color, linewidth=1.3,
                label=f"$\\lambda$={dr}")

    ax.axhline(0.25, color="#999", linewidth=0.8, linestyle=":",
               label="Prior variance")
    ax.set_xlabel("Ticks without observation")
    ax.set_ylabel("Mood belief variance $\\sigma^2$")
    ax.set_title("(b) Belief variance converges\nto prior")
    ax.legend(fontsize=7, title="Decay rate", title_fontsize=7)
    ax.grid(True, alpha=0.3)

    fig.tight_layout()
    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"    图已保存: {output_path}")


# ═══════════════════════════════════════════════════════════════════════════
# 入口
# ═══════════════════════════════════════════════════════════════════════════

def run_all() -> dict:
    """运行全部 4 个 POMDP 信念更新实验。"""
    print("=" * 60)
    print("POMDP 信念更新模拟实验")
    print("=" * 60)

    results = {}

    # Exp1
    results["exp1"] = run_exp1()
    fig_dir = os.path.join(os.path.dirname(__file__), "figures")
    os.makedirs(fig_dir, exist_ok=True)
    plot_exp1(results["exp1"], os.path.join(fig_dir, "pomdp_exp1_mse_vs_obs.png"))

    # Exp2
    results["exp2"] = run_exp2()
    plot_exp2(results["exp2"], os.path.join(fig_dir, "pomdp_exp2_uncertainty_penalty.png"))

    # Exp3
    results["exp3"] = run_exp3()
    plot_exp3(results["exp3"], os.path.join(fig_dir, "pomdp_exp3_voi.png"))

    # Exp4
    results["exp4"] = run_exp4()
    plot_exp4(results["exp4"], os.path.join(fig_dir, "pomdp_exp4_belief_decay.png"))

    # 总结
    print("\n" + "=" * 60)
    print("实验结果汇总")
    print("=" * 60)
    print(f"  Exp1: MSE(interval=1)={results['exp1']['mean_mse'][0]:.4f}, "
          f"MSE(interval=100)={results['exp1']['mean_mse'][-1]:.4f}")
    print(f"  Exp2: 行动减少 {results['exp2']['action_reduction_pct']:.1f}% "
          f"(有不确定性惩罚)")
    corr = np.corrcoef(results["exp3"]["all_uncertainty"],
                       results["exp3"]["all_voi"])[0, 1]
    print(f"  Exp3: Entropy-VoI 相关系数 r={corr:.3f}")
    print(f"  Exp4: 半衰期范围 {results['exp4']['half_life_ticks'][0]}"
          f"-{results['exp4']['half_life_ticks'][-1]} ticks")
    print(f"  图表已保存到 {fig_dir}")

    return results


if __name__ == "__main__":
    run_all()
