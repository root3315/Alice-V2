"""运行全部实验并生成论文所需的图表。"""
from __future__ import annotations

import sys
import os
import time

# 将 simulation/ 目录加入路径
sys.path.insert(0, os.path.dirname(__file__))

from experiments.exp1_idle_growth import run_exp1, plot_exp1
from experiments.exp2_personality import run_exp2, plot_exp2
from experiments.exp3_rhythm import run_exp3, plot_exp3
from experiments.exp4_sigmoid import run_exp4, plot_exp4
from voices import VOICE_SHORT

# Exp5 按需导入（需要测试数据）
_EXP5_DATA = os.path.join(os.path.dirname(__file__), "testdata", "chat_frontend.json")


def main() -> None:
    fig_dir = os.path.join(
        os.path.dirname(__file__), "..", "paper", "figures"
    )
    os.makedirs(fig_dir, exist_ok=True)

    t0 = time.time()

    # -----------------------------------------------------------------------
    print("=" * 60)
    print("实验 1：空闲增长定理验证")
    print("=" * 60)
    r1 = run_exp1(n_trials=100, n_steps=100)
    plot_exp1(r1, os.path.join(fig_dir, "exp1_idle_growth.pdf"))

    # -----------------------------------------------------------------------
    print("\n" + "=" * 60)
    print("实验 2：人格向量对行动分布的影响")
    print("=" * 60)
    r2 = run_exp2(n_trials=100, n_steps=100)
    plot_exp2(r2, os.path.join(fig_dir, "exp2_personality.pdf"))

    # -----------------------------------------------------------------------
    print("\n" + "=" * 60)
    print("实验 3：涌现节律验证")
    print("=" * 60)
    r3 = run_exp3(n_trials=50, n_steps=200)
    plot_exp3(r3, os.path.join(fig_dir, "exp3_rhythm.pdf"))

    # -----------------------------------------------------------------------
    print("\n" + "=" * 60)
    print("实验 4：P3 关系冷却 sigmoid 验证")
    print("=" * 60)
    r4 = run_exp4(beta=0.15)
    plot_exp4(r4, os.path.join(fig_dir, "exp4_sigmoid.pdf"))

    # -----------------------------------------------------------------------
    # 实验 5（需要 Telegram 导出数据）
    if os.path.exists(_EXP5_DATA):
        print("\n" + "=" * 60)
        print("实验 5：Telegram 事件流回放模拟")
        print("=" * 60)
        from experiments.exp5_telegram_replay import run_exp5, plot_exp5
        r5 = run_exp5(data_paths=[_EXP5_DATA])
        plot_exp5(r5, fig_dir)
    else:
        print(f"\n  跳过实验 5：未找到测试数据 {_EXP5_DATA}")
        r5 = None

    # -----------------------------------------------------------------------
    print("\n" + "=" * 60)
    print("实验 6：图动态特性验证（v3）")
    print("=" * 60)
    from experiments.exp6_graph_dynamics import run_exp6, plot_exp6
    r6 = run_exp6()
    plot_exp6(r6, os.path.join(fig_dir, "exp6_graph_dynamics.pdf"))

    # -----------------------------------------------------------------------
    print("\n" + "=" * 60)
    print("实验 7：Laplacian 压力传播验证（v4）")
    print("=" * 60)
    from experiments.exp7_propagation import run_exp7, plot_exp7
    r7 = run_exp7()
    plot_exp7(r7, os.path.join(fig_dir, "exp7_propagation.pdf"))

    # -----------------------------------------------------------------------
    print("\n" + "=" * 60)
    print("实验 8：行动频率门验证（v4）")
    print("=" * 60)
    from experiments.exp8_action_gate import run_exp8, plot_exp8
    r8 = run_exp8()
    plot_exp8(r8, os.path.join(fig_dir, "exp8_action_gate.pdf"))

    # -----------------------------------------------------------------------
    print("\n" + "=" * 60)
    print("实验 9：声部覆盖性验证")
    print("=" * 60)
    from experiments.exp9_voice_coverage import run_exp9, plot_exp9
    r9 = run_exp9()
    plot_exp9(r9, os.path.join(fig_dir, "exp9_voice_coverage.pdf"))

    # -----------------------------------------------------------------------
    elapsed = time.time() - t0
    print(f"\n{'=' * 60}")
    print(f"全部实验完成，耗时 {elapsed:.1f} 秒")
    print(f"图表已保存至: {fig_dir}/")
    print(f"{'=' * 60}")

    # 输出论文所需的关键数值摘要
    print("\n论文关键数值:")

    # Exp 1: 空闲增长
    a_p4, b_p4 = r1["fit_p4"]
    print(f"  Exp1 P4 幂律拟合: P4(t) = {a_p4:.2f} * t^{b_p4:.2f}, "
          f"R² = {r1['r2_p4']:.4f}")
    c, a, b = r1["fit_api"]
    print(f"  Exp1 API 幂律拟合: API(t) = {c:.2f} + {a:.2f} * t^{b:.2f}, "
          f"R² = {r1['r2_api']:.4f}")
    print(f"  Exp1 单调递增比例: {r1['monotone_ratio']:.4f}")

    # Exp 2: 人格
    print(f"\n  Exp2 行动分布摘要:")
    for pname, counts in r2.items():
        mean_counts = counts.mean(axis=0)
        total = mean_counts.sum()
        dominant = int(mean_counts.argmax())
        pct = mean_counts[dominant] / total * 100
        print(f"    {pname:>10s}: dominant voice = {VOICE_SHORT[dominant]} ({pct:.1f}%)")

    # Exp 3: 节律
    print(f"\n  Exp3 平均行动间隔: {r3['mean_interval']:.1f} ± {r3['std_interval']:.1f} ticks")
    print(f"  Exp3 均值 API 零交叉次数: {r3['crossings']}")

    # Exp 4: sigmoid
    for tier_str, data in r4.items():
        print(f"  Exp4 Tier {tier_str}: θ={data['theta']:.1f}, "
              f"inflection={data['inflection']:.2f}, "
              f"P3(θ)={data['p3_at_inflection']:.3f} (w/2={data['w']/2:.3f})")

    # Exp 6: 图动态特性
    print(f"\n  Exp6 Part A (Snapshot): {'PASS' if r6['a']['full_match'] else 'FAIL'}")
    print(f"  Exp6 Part B (Tier): c0={r6['b']['c0_final_tier']}, "
          f"升级={'Y' if r6['b']['c0_upgraded'] else 'N'}, "
          f"静默正确={'Y' if r6['b']['silent_all_correct'] else 'N'}")
    print(f"  Exp6 Part C (Chat): P5_private={r6['c']['p5_private']:.2f}, "
          f"P5_group={r6['c']['p5_group']:.2f}")

    # Exp 7: 传播
    print(f"\n  Exp7 Part A: API 比率 = {r7['a']['mean_api_ratio']:.4f}")
    print(f"  Exp7 Part B: 权重排序 {'PASS' if r7['b']['order_correct'] else 'FAIL'}")
    print(f"  Exp7 Part C: 增益实体 = {r7['c']['n_entities_with_gain']}")

    # Exp 8: 行动频率门
    print(f"\n  Exp8 Part A: CV(gate)={r8['a']['cv_gate']:.3f}, "
          f"CV(no_gate)={r8['a']['cv_no_gate']:.3f}")
    print(f"  Exp8 Part B: 主动效应 {'PASS' if r8['b']['gate_more_active'] else 'FAIL'}")
    print(f"  Exp8 Part C: 行动数 gate={r8['c']['gate']['n_actions']}, "
          f"no_gate={r8['c']['no_gate']['n_actions']}")

    # Exp 9: 声部覆盖性
    biased_pass = all(r["pass"] for r in r9["biased"].values())
    uniform_pass = all(r["pass"] for r in r9["uniform"].values())
    print(f"\n  Exp9 Part A (偏向人格): {'ALL PASS' if biased_pass else 'SOME FAIL'}")
    print(f"  Exp9 Part B (均匀人格): {'ALL PASS' if uniform_pass else 'SOME FAIL'}")
    for name, r in r9["biased"].items():
        target = VOICE_SHORT[r["target_voice"]]
        rate = r["target_win_rate"] * 100
        print(f"    {name}: target={target}, win_rate={rate:.1f}%")

    # Exp 5: Telegram replay
    if r5 is not None:
        print(f"\n  Exp5 总 ticks: {r5['total_ticks']}, 行动: {r5['n_actions']}")
        print(f"  Exp5 API: mean={r5['api_mean']:.1f}, max={r5['api_max']:.1f}")
        print(f"  Exp5 事件-压力相关性: {r5['correlation']:.3f}")
        print(f"  Exp5 行动间隔: {r5['mean_interval']:.1f} ± {r5['std_interval']:.1f}")
        print(f"  Exp5 人格漂移: {r5['pi_drift']:.6f}")


if __name__ == "__main__":
    main()
