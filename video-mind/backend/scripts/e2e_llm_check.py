"""用真实 LLM 跑一遍「分章节 + 生成思维导图」。

Whisper 模型在当前网络下拿不到，因此这里用一段合成的讲座转写代替 ASR 输出，
其余环节（真实 API 调用、JSON 解析、时间戳防幻觉、导图生成）都是真的。

用法：
    python scripts/e2e_llm_check.py
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline import chapter as chapter_mod  # noqa: E402
from pipeline import mindmap as mindmap_mod  # noqa: E402
from providers.asr.base import Segment  # noqa: E402

# 模拟一段 20 分钟的 AI 入门讲座转写（每 40 秒一段，共 30 段）
LECTURE = [
    "大家好，欢迎来到人工智能入门课程，今天我们要讲的是机器学习的基础知识。",
    "首先我们要理解一个核心问题，什么是机器学习。简单来说，机器学习就是让计算机从数据中自动学习规律，而不是由人手工编写规则。",
    "举个例子，传统的编程是人写规则，计算机执行。而机器学习是人提供数据，计算机自己找出规则。这是两种完全不同的思路。",
    "机器学习主要分为三大类，监督学习、无监督学习和强化学习。我们先来看监督学习。",
    "监督学习的特点是，训练数据里既有输入，也有对应的正确答案，也就是标签。模型的目标就是学会从输入映射到正确的输出。",
    "监督学习最典型的两个任务是分类和回归。分类是预测离散的类别，比如判断一封邮件是不是垃圾邮件。回归是预测连续的数值，比如预测房价。",
    "常见的监督学习算法有线性回归、逻辑回归、决策树、支持向量机，还有随机森林。这些算法各有适用场景。",
    "接下来看无监督学习。和监督学习不同，无监督学习的训练数据里没有标签，只有输入。",
    "无监督学习最典型的应用是聚类，就是把相似的样本自动归到一起。比如客户分群，把消费行为相似的用户分成一类。",
    "另一个重要的无监督学习任务是降维，比如 PCA 主成分分析，可以在保留主要信息的前提下把高维数据压缩到低维。",
    "第三种是强化学习。强化学习的思路完全不同，它没有一个标准答案，而是通过与环境交互获得奖励信号来学习。",
    "强化学习里有几个核心概念，智能体、环境、状态、动作和奖励。智能体观察状态，采取动作，环境给出奖励，如此循环。",
    "强化学习的经典应用是游戏，比如 AlphaGo 下围棋，还有机器人控制、自动驾驶这些领域。",
    "讲完了三大类，我们再来看看具体的算法。先从最基础的线性回归说起。",
    "线性回归的思路是，假设输入和输出之间存在线性关系，我们用一条直线去拟合数据点。",
    "怎么衡量拟合得好不好呢？我们用一个叫损失函数的东西，最常见的是均方误差，也就是预测值和真实值差距的平方的平均。",
    "有了损失函数，接下来的问题就是怎么让它最小。这就引出了梯度下降算法。",
    "梯度下降的思想很直观，就像下山一样，每次沿着最陡的方向走一小步，一步步走到谷底。这个步长叫做学习率。",
    "学习率是个很重要的超参数。太大会导致震荡甚至发散，太小则收敛很慢。这是实践中经常要调的参数。",
    "说完线性回归，我们再讲一个非常常用的算法，决策树。决策树通过一系列的是否判断来做决策，非常直观。",
    "决策树的关键问题是如何选择分裂特征。常用的指标有信息增益和基尼系数，目标是让每次分裂后子集的纯度更高。",
    "单棵决策树容易过拟合，所以实践中更多使用随机森林，也就是把很多棵决策树的结果综合起来。这种方法叫做集成学习。",
    "讲完了算法，我们必须聊聊一个绕不开的话题，过拟合。",
    "过拟合是指模型在训练集上表现很好，但在新的数据上表现很差。就像一个学生把练习题背下来了，但考试遇到新题就不会做。",
    "解决过拟合有几种常见手段。第一是增加数据量，第二是正则化，比如 L1 和 L2 正则，第三是 dropout，还有早停法。",
    "正则化的思想是在损失函数里加一个惩罚项，限制模型的复杂度，防止它把训练数据里的噪声也学进去。",
    "那怎么评估模型到底好不好呢？这就需要我们划分训练集、验证集和测试集。",
    "训练集用来训练模型，验证集用来调超参数，测试集用来最终评估。测试集必须是模型从来没见过的数据，否则评估结果不可信。",
    "评估指标方面，分类任务常用准确率、精确率、召回率和 F1 分数，回归任务常用均方误差和 R 平方。",
    "今天我们讲了机器学习的三大类、几个基础算法、过拟合问题以及模型评估方法。下节课我们会深入讲神经网络和深度学习，谢谢大家。"
]


def make_segments() -> list[Segment]:
    """每段 40 秒，共 30 段 = 1200 秒（20 分钟）。"""
    return [
        Segment(start=i * 40.0, end=(i + 1) * 40.0, text=text)
        for i, text in enumerate(LECTURE)
    ]


def main() -> int:
    segs = make_segments()
    print("=" * 66)
    print("  真实 LLM 端到端验证：分章节 -> 思维导图")
    print("=" * 66)
    print(f"  转写：{len(segs)} 段，总时长 {segs[-1].end / 60:.0f} 分钟，"
          f"{sum(len(s.text) for s in segs)} 字")
    print()

    # ---------------- 分章节 ----------------
    print("── 阶段 1：调用真实 DeepSeek 分章节 ──")
    t0 = time.time()
    chapters = chapter_mod.build_chapters(
        segs, on_progress=lambda p, m: print(f"   [{p}%] {m}")
    )
    t1 = time.time()
    print(f"  ✓ 完成，耗时 {t1 - t0:.1f}s，共 {len(chapters)} 章")
    print()

    # 校验：所有时间戳必须吸附到真实片段起点
    real = {s.start for s in segs}
    bad = [c for c in chapters if c["start"] not in real]
    print(f"  防幻觉校验：{len(chapters) - len(bad)}/{len(chapters)} 章起点落在真实语音起点上"
          f"{'  ✓' if not bad else '  ✗ 有未吸附的：' + str([c['start'] for c in bad])}")

    monotonic = all(chapters[i]["end"] == chapters[i + 1]["start"] for i in range(len(chapters) - 1))
    print(f"  首尾相接校验：{'✓ 无空隙无重叠' if monotonic else '✗ 存在空隙或重叠'}")
    print(f"  首章从 0 开始：{'✓' if chapters[0]['start'] == 0 else '✗'}"
          f"   末章到 {chapters[-1]['end']:.0f}s：{'✓' if chapters[-1]['end'] == segs[-1].end else '✗'}")
    print()

    print("  章节一览：")
    for c in chapters:
        kp = "、".join(c["key_points"][:2])
        print(f"    [{chapter_mod.format_ts(c['start'])}–{chapter_mod.format_ts(c['end'])}] {c['title']}")
        print(f"        {(c['summary'] or '')[:52]}{'…' if len(c.get('summary') or '') > 52 else ''}")
        if kp:
            print(f"        要点：{kp[:44]}")
    print()

    # ---------------- 思维导图 ----------------
    print("── 阶段 2：调用真实 DeepSeek 生成思维导图 ──")
    t2 = time.time()
    tree = mindmap_mod.build_mindmap(chapters, video_title="机器学习入门讲座")
    t3 = time.time()
    print(f"  ✓ 完成，耗时 {t3 - t2:.1f}s")

    def count(node) -> int:
        return 1 + sum(count(k) for k in node.get("children") or [])

    print(f"  根节点：{tree['label']}")
    print(f"  节点总数：{count(tree)}")
    print()

    # 校验：所有节点时间戳必须在视频时长内
    duration = segs[-1].end
    out_of_range = []

    def check(node):
        s = node.get("start")
        if s is not None and not (0 <= s <= duration):
            out_of_range.append((node["label"], s))
        for k in node.get("children") or []:
            check(k)

    check(tree)
    print(f"  时间戳范围校验：{'✓ 全部在 0–' + str(int(duration)) + 's 内' if not out_of_range else '✗ 越界：' + str(out_of_range)}")

    no_ts = []

    def check_ts(node):
        if node.get("start") is None:
            no_ts.append(node["label"])
        for k in node.get("children") or []:
            check_ts(k)

    check_ts(tree)
    print(f"  可跳转性校验：{'✓ 每个节点都有时间点' if not no_ts else '✗ 无时间戳的节点：' + str(no_ts)}")
    print()

    print("  导图结构：")

    def show(node, depth=0):
        pad = "  " * depth
        ts = f"  [{chapter_mod.format_ts(node['start'])}]" if node.get("start") is not None else ""
        print(f"    {pad}{'└ ' if depth else ''}{node['label']}{ts}")
        for k in node.get("children") or []:
            show(k, depth + 1)

    show(tree)

    # ---------------- 落盘 ----------------
    out = Path(__file__).resolve().parent.parent.parent / "data" / "e2e_real_llm_result.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps({"chapters": chapters, "mindmap": tree}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print()
    print(f"  结果已保存：{out}")
    print()
    print("=" * 66)
    ok = not bad and monotonic and not out_of_range and not no_ts
    print(f"  结论：{'✓ 全部通过' if ok else '✗ 存在未通过项'}")
    print("=" * 66)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
