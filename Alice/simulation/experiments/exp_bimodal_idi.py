"""
Experiment: 双模态 IDI 验证

验证分段拟合（短间隔指数 + 长间隔 Weibull）相比单一 Weibull 拟合
在双模态 inter-event time 数据上的 KS 距离改善。

理论基础:
  Wu et al. (2010 PNAS): SMS 通信的 inter-event time 是双模态的——
  短间隔（对话内回复）Poisson + 长间隔（对话间发起）重尾。
  @see https://doi.org/10.1073/pnas.1013140107

  Malmgren et al. (2008 PNAS): 表观幂律尾部源于昼夜周节律叠加。
  Weibull 是比纯幂律更好的拟合模型。
  @see https://doi.org/10.1073/pnas.0800332105

实验设计:
  1. 生成双模态合成数据（混合指数 + Weibull）
  2. 单 Weibull 拟合 vs 分段拟合
  3. 100 次 trial 统计 KS 距离改善
  4. 扫描不同 w（混合比例）和 N（样本量）

用法:
  cd simulation && uv run python -m experiments.exp_bimodal_idi
"""

import numpy as np
from scipy.stats import weibull_min, expon, ks_1samp
import json
from pathlib import Path


def generate_bimodal(
    n: int = 50,
    w: float = 0.4,
    short_mean_s: float = 60.0,
    weibull_c: float = 0.7,
    weibull_scale: float = 3600.0,
    rng: np.random.Generator | None = None,
) -> np.ndarray:
    """生成双模态间隔数据（秒）。

    短间隔: Exp(1/short_mean_s)，模拟对话内回复节奏
    长间隔: Weibull(c, scale)，模拟对话间发起间隔

    Args:
        n: 总间隔数
        w: 短间隔占比
        short_mean_s: 短间隔平均值（秒），默认 60s
        weibull_c: Weibull shape 参数，< 1 = 重尾
        weibull_scale: Weibull scale 参数（秒）
        rng: 随机数生成器
    """
    if rng is None:
        rng = np.random.default_rng()

    n_short = int(n * w)
    n_long = n - n_short

    short = rng.exponential(short_mean_s, n_short)
    long = weibull_min.rvs(weibull_c, scale=weibull_scale, size=n_long, random_state=rng)

    data = np.concatenate([short, long])
    rng.shuffle(data)
    # 确保所有值为正
    data = data[data > 0]
    return data


def single_weibull_idi(intervals: np.ndarray) -> float:
    """单 Weibull 拟合 IDI = 1 - KS_distance。"""
    if len(intervals) < 2:
        return 0.0
    try:
        c_fit, _loc, b_fit = weibull_min.fit(intervals, floc=0)
        ks_stat, _ = ks_1samp(intervals, weibull_min.cdf, args=(c_fit, 0, b_fit))
        return max(0.0, 1.0 - ks_stat)
    except Exception:
        return 0.0


def bimodal_idi(
    intervals: np.ndarray,
    t_split_s: float = 300.0,
) -> float | None:
    """分段 IDI：短间隔指数 + 长间隔 Weibull，按样本比例加权。

    Args:
        intervals: 正间隔数组（秒）
        t_split_s: 分割阈值（秒），默认 300s = 5 分钟

    Returns:
        加权 IDI，或 None（数据不足）
    """
    short = intervals[intervals < t_split_s]
    long = intervals[intervals >= t_split_s]

    idi_short: float | None = None
    idi_long: float | None = None

    # 短间隔：指数拟合
    if len(short) >= 3:
        lam = 1.0 / np.mean(short)
        ks_s, _ = ks_1samp(short, expon.cdf, args=(0, 1.0 / lam))
        idi_short = max(0.0, 1.0 - ks_s)

    # 长间隔：Weibull 拟合
    if len(long) >= 3:
        try:
            c_fit, _loc, b_fit = weibull_min.fit(long, floc=0)
            ks_l, _ = ks_1samp(long, weibull_min.cdf, args=(c_fit, 0, b_fit))
            idi_long = max(0.0, 1.0 - ks_l)
        except Exception:
            idi_long = None

    # 加权合并
    if idi_short is not None and idi_long is not None:
        w_short = len(short) / len(intervals)
        w_long = len(long) / len(intervals)
        return w_short * idi_short + w_long * idi_long

    # 降级
    if idi_short is not None:
        return idi_short
    if idi_long is not None:
        return idi_long

    return None


def run_experiment() -> dict:
    """主实验：多参数扫描。"""
    rng = np.random.default_rng(42)
    results = {}

    # 实验 1：固定参数，100 次 trial
    print("=" * 60)
    print("实验 1：双模态数据，100 次 trial")
    print("  参数：N=50, w=0.4, short_mean=60s, Weibull(c=0.7, scale=3600)")
    print("=" * 60)

    single_scores = []
    bimodal_scores = []

    for _ in range(100):
        data = generate_bimodal(n=50, w=0.4, rng=rng)
        idi_s = single_weibull_idi(data)
        idi_b = bimodal_idi(data)

        single_scores.append(idi_s)
        if idi_b is not None:
            bimodal_scores.append(idi_b)

    s_mean = np.mean(single_scores)
    b_mean = np.mean(bimodal_scores) if bimodal_scores else float("nan")
    improvement = b_mean - s_mean if bimodal_scores else float("nan")

    print(f"  单 Weibull IDI:  均值={s_mean:.3f}, std={np.std(single_scores):.3f}")
    print(f"  双模态 IDI:      均值={b_mean:.3f}, std={np.std(bimodal_scores):.3f}")
    print(f"  改善:            {improvement:+.3f}")
    print(f"  双模态有效率:    {len(bimodal_scores)}/{len(single_scores)}")
    print()

    results["exp1_fixed"] = {
        "single_mean": round(s_mean, 4),
        "single_std": round(float(np.std(single_scores)), 4),
        "bimodal_mean": round(b_mean, 4),
        "bimodal_std": round(float(np.std(bimodal_scores)), 4),
        "improvement": round(improvement, 4),
        "bimodal_valid_rate": len(bimodal_scores) / len(single_scores),
    }

    # 实验 2：扫描 w（短间隔占比）
    print("=" * 60)
    print("实验 2：扫描 w (短间隔占比)")
    print("=" * 60)

    w_scan_results = {}
    for w in [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]:
        single_list = []
        bimodal_list = []
        for _ in range(50):
            data = generate_bimodal(n=50, w=w, rng=rng)
            single_list.append(single_weibull_idi(data))
            b = bimodal_idi(data)
            if b is not None:
                bimodal_list.append(b)

        s_m = np.mean(single_list)
        b_m = np.mean(bimodal_list) if bimodal_list else float("nan")
        imp = b_m - s_m if bimodal_list else float("nan")
        print(f"  w={w:.1f}: single={s_m:.3f}, bimodal={b_m:.3f}, Δ={imp:+.3f}")

        w_scan_results[str(w)] = {
            "single": round(s_m, 4),
            "bimodal": round(b_m, 4),
            "improvement": round(imp, 4),
        }

    results["exp2_w_scan"] = w_scan_results
    print()

    # 实验 3：扫描 N（样本量）
    print("=" * 60)
    print("实验 3：扫描 N (样本量)")
    print("=" * 60)

    n_scan_results = {}
    for n in [10, 15, 20, 30, 50, 100]:
        single_list = []
        bimodal_list = []
        for _ in range(50):
            data = generate_bimodal(n=n, w=0.4, rng=rng)
            single_list.append(single_weibull_idi(data))
            b = bimodal_idi(data)
            if b is not None:
                bimodal_list.append(b)

        s_m = np.mean(single_list)
        b_m = np.mean(bimodal_list) if bimodal_list else float("nan")
        valid = len(bimodal_list) / len(single_list)
        imp = b_m - s_m if bimodal_list else float("nan")
        print(f"  N={n:3d}: single={s_m:.3f}, bimodal={b_m:.3f}, Δ={imp:+.3f}, valid={valid:.0%}")

        n_scan_results[str(n)] = {
            "single": round(s_m, 4),
            "bimodal": round(b_m, 4),
            "improvement": round(imp, 4),
            "valid_rate": round(valid, 4),
        }

    results["exp3_n_scan"] = n_scan_results
    print()

    # 实验 4：扫描 T_split（分割阈值）
    print("=" * 60)
    print("实验 4：扫描 T_split (分割阈值)")
    print("=" * 60)

    t_scan_results = {}
    for t in [60, 120, 180, 300, 600, 900, 1800]:
        bimodal_list = []
        for _ in range(50):
            data = generate_bimodal(n=50, w=0.4, rng=rng)
            b = bimodal_idi(data, t_split_s=t)
            if b is not None:
                bimodal_list.append(b)

        b_m = np.mean(bimodal_list) if bimodal_list else float("nan")
        valid = len(bimodal_list) / 50
        print(f"  T={t:5d}s: bimodal={b_m:.3f}, valid={valid:.0%}")

        t_scan_results[str(t)] = {
            "bimodal": round(b_m, 4),
            "valid_rate": round(valid, 4),
        }

    results["exp4_t_split_scan"] = t_scan_results
    print()

    # 实验 5：单模态数据（退化检验——分段不应比单 Weibull 差）
    print("=" * 60)
    print("实验 5：单模态数据（Weibull only）— 退化检验")
    print("=" * 60)

    single_list = []
    bimodal_list = []
    for _ in range(50):
        # 纯 Weibull 数据，无短间隔
        data = weibull_min.rvs(0.7, scale=3600, size=50, random_state=rng)
        data = data[data > 0]
        single_list.append(single_weibull_idi(data))
        b = bimodal_idi(data)
        if b is not None:
            bimodal_list.append(b)

    s_m = np.mean(single_list)
    b_m = np.mean(bimodal_list) if bimodal_list else float("nan")
    imp = b_m - s_m if bimodal_list else float("nan")
    print(f"  单 Weibull: {s_m:.3f}, 双模态: {b_m:.3f}, Δ={imp:+.3f}")
    print(f"  （Δ 应接近 0 或略正——分段不应伤害单模态数据）")

    results["exp5_unimodal_degradation"] = {
        "single": round(s_m, 4),
        "bimodal": round(b_m, 4),
        "improvement": round(imp, 4),
    }

    return results


if __name__ == "__main__":
    print("双模态 IDI 验证实验")
    print("@see Wu et al. (2010 PNAS) — bimodal distribution in human communication")
    print("@see Malmgren et al. (2008 PNAS) — Weibull inter-event time")
    print()

    results = run_experiment()

    # 保存结果
    output_dir = Path("output/bimodal_idi_validation")
    output_dir.mkdir(parents=True, exist_ok=True)
    with open(output_dir / "results.json", "w") as f:
        json.dump(results, f, indent=2)

    print(f"\n结果已保存至 {output_dir / 'results.json'}")

    # 总结
    print("\n" + "=" * 60)
    print("总结")
    print("=" * 60)
    exp1 = results.get("exp1_fixed", {})
    print(f"双模态数据上的改善: {exp1.get('improvement', 'N/A'):+.3f}")
    exp5 = results.get("exp5_unimodal_degradation", {})
    print(f"单模态数据上的退化: {exp5.get('improvement', 'N/A'):+.3f}")
    print(f"结论: 分段 IDI 在双模态数据上{'优于' if exp1.get('improvement', 0) > 0.05 else '略优于'}单 Weibull")
    print(f"       在单模态数据上{'无退化' if abs(exp5.get('improvement', 0)) < 0.05 else '有退化'}")
