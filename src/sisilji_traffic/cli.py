from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from .experiment import ExperimentConfig, run_experiment, summarize_repeats, write_json


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="Synthetic three-intersection SUMO prototype")
    sub = root.add_subparsers(dest="command", required=True)
    for command in ("demo", "benchmark"):
        p = sub.add_parser(command)
        p.add_argument("--out", type=Path, default=Path("runs") / command)
        p.add_argument("--duration", type=int, default=1200)
        p.add_argument("--demand-duration", type=int, default=960)
        p.add_argument("--decisions", type=int, default=3)
        p.add_argument("--planning-seed", type=int, default=10000)
        p.add_argument("--deadline-seconds", type=float, default=20)
        p.add_argument("--horizon-cycles", type=int, choices=(2, 4, 8), default=2)
        p.add_argument("--policies", nargs="+", default=["fixed", "no_diagnosis", "recommended"],
                       choices=("fixed", "no_diagnosis", "recommended", "full_search"))
        if command == "demo":
            p.add_argument("--scenario", choices=("normal", "imbalanced", "surge", "downstream"), default="imbalanced")
            p.add_argument("--seed", type=int, default=7)
        else:
            p.add_argument("--scenarios", nargs="+", choices=("normal", "imbalanced", "surge", "downstream"),
                           default=["normal", "imbalanced", "downstream"])
            p.add_argument("--seeds", nargs="+", type=int, default=[1, 2, 3])
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.command == "benchmark" and "fixed" not in args.policies:
        parser().error("benchmark requires the fixed policy for paired comparisons")
    try:
        shared = {key: getattr(args, key) for key in (
            "duration", "demand_duration", "decisions", "planning_seed",
            "deadline_seconds", "horizon_cycles")}
        shared["policies"] = tuple(args.policies)
        if args.command == "demo":
            result = run_experiment(args.out, ExperimentConfig(scenario=args.scenario,
                                    seed=args.seed, **shared))
            print(json.dumps({"output": str(args.out.resolve()), "results": result["results"]},
                             ensure_ascii=False, indent=2))
        else:
            if len(set(args.seeds)) != len(args.seeds) or len(set(args.scenarios)) != len(args.scenarios):
                raise ValueError("Use distinct seeds and scenarios")
            summaries = []
            for scenario in args.scenarios:
                for seed in args.seeds:
                    print(f"Running {scenario}, seed={seed}", flush=True)
                    summaries.append(run_experiment(args.out / scenario / f"seed_{seed}",
                                     ExperimentConfig(scenario=scenario, seed=seed, **shared)))
            result = summarize_repeats(summaries)
            write_json(args.out / "benchmark.json", result)
            print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, RuntimeError, FileNotFoundError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    return 0
