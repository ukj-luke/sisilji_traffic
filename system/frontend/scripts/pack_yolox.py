"""YOLOX-Tiny의 합성곱 가중치를 채널별 8비트로 저장합니다. 실행 시에는 float32로 복원합니다."""
import argparse
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


def pack(source: Path, output: Path):
    model = onnx.load(source)
    graph = model.graph
    kernels = {node.input[1] for node in graph.node if node.op_type == "Conv"}
    unpack = []
    for weight in list(graph.initializer):
        if weight.name not in kernels:
            continue
        name = weight.name
        values = numpy_helper.to_array(weight)
        scale = np.maximum(np.abs(values).max(axis=(1, 2, 3), keepdims=True) / 127, 1e-10)
        packed = np.rint(values / scale).clip(-127, 127).astype(np.int8)
        graph.initializer.remove(weight)
        graph.initializer.extend([numpy_helper.from_array(packed, name + "_int8"),
                                  numpy_helper.from_array(scale.astype(np.float32), name + "_scale")])
        unpack.extend([helper.make_node("Cast", [name + "_int8"], [name + "_float"], to=TensorProto.FLOAT),
                       helper.make_node("Mul", [name + "_float", name + "_scale"], [name])])
    nodes = list(graph.node)
    del graph.node[:]
    graph.node.extend([*unpack, *nodes])
    onnx.checker.check_model(model)
    onnx.save(model, output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    pack(args.source, args.output)
