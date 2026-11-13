"""Build a deliberately fictional, straight-only three-junction SUMO corridor."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

DIRECTIONS = ("west", "north", "east", "south")
REFERENCE_GREENS = (30, 20, 30, 20)
CYCLE_SECONDS = 120
YELLOW_SECONDS = 3
ALL_RED_SECONDS = 2
B_INCOMING = ("A_B", "Bn_B", "C_B", "Bs_B")
B_DOWNSTREAM = ("B_C", "B_Bs", "B_A", "B_Bn")
ROUTES = {
    "eastbound": ("W_A", "A_B", "B_C", "C_E"),
    "westbound": ("E_C", "C_B", "B_A", "A_W"),
    "A_ns": ("An_A", "A_As"),
    "A_sn": ("As_A", "A_An"),
    "B_ns": ("Bn_B", "B_Bs"),
    "B_sn": ("Bs_B", "B_Bn"),
    "C_ns": ("Cn_C", "C_Cs"),
    "C_sn": ("Cs_C", "C_Cn"),
}


@dataclass(frozen=True)
class Network:
    directory: Path
    net_file: Path
    routes_file: Path
    config_file: Path


def resolve_binary(name: str) -> str:
    """Support normal SUMO installs and the eclipse-sumo virtualenv wheels."""
    binary = shutil.which(name)
    if binary:
        return binary
    sibling = Path(sys.executable).parent / name
    if sibling.is_file():
        return str(sibling)
    raise RuntimeError(
        f"{name} was not found. Install this project's SUMO dependencies and "
        "activate the virtual environment, or add SUMO/bin to PATH."
    )


def _write(path: Path, root: ET.Element) -> None:
    ET.indent(root)
    ET.ElementTree(root).write(path, encoding="utf-8", xml_declaration=True)


def phase_specs(greens=REFERENCE_GREENS) -> list[tuple[int, str]]:
    if len(greens) != 4 or any(isinstance(g, bool) or int(g) != g for g in greens):
        raise ValueError("Four integer green durations are required")
    if sum(greens) + 4 * (YELLOW_SECONDS + ALL_RED_SECONDS) != CYCLE_SECONDS:
        raise ValueError("Signal cycle must remain 120 seconds")
    if any(g < 15 or g > 45 for g in greens):
        raise ValueError("Virtual green bounds are 15 to 45 seconds")
    phases = []
    for i, green in enumerate(greens):
        state = ["r"] * 4
        state[i] = "G"
        phases.append((int(green), "".join(state)))
        state[i] = "y"
        phases.append((YELLOW_SECONDS, "".join(state)))
        phases.append((ALL_RED_SECONDS, "rrrr"))
    return phases


def build_network(directory: str | Path) -> Network:
    """Generate plain XML and compile it with netconvert; no real GIS is used.

    Every approach has one lane and only a straight connection. One approach
    receives green at a time. All A/C offsets are fixed at zero in this first
    model. The two internal distances between junction centres are 300 metres.
    """
    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    nodes = ET.Element("nodes")
    points = {"W": (-300, 0), "E": (900, 0), "A": (0, 0), "B": (300, 0), "C": (600, 0)}
    for name, x in (("A", 0), ("B", 300), ("C", 600)):
        points[f"{name}n"] = (x, 200)
        points[f"{name}s"] = (x, -200)
    for node, (x, y) in points.items():
        ET.SubElement(nodes, "node", id=node, x=str(x), y=str(y),
                      type="traffic_light" if node in "ABC" else "priority")
    edges = ET.Element("edges")
    pairs = [("W", "A"), ("A", "B"), ("B", "C"), ("C", "E")]
    pairs += [(f"{j}n", j) for j in "ABC"] + [(f"{j}s", j) for j in "ABC"]
    for a, b in pairs:
        for src, dst in ((a, b), (b, a)):
            ET.SubElement(edges, "edge", id=f"{src}_{dst}", **{
                "from": src, "to": dst, "numLanes": "1", "speed": "13.89", "priority": "1"
            })
    connections = ET.Element("connections")
    for junction, west, east in (("A", "W", "B"), ("B", "A", "C"), ("C", "B", "E")):
        incoming = (f"{west}_{junction}", f"{junction}n_{junction}",
                    f"{east}_{junction}", f"{junction}s_{junction}")
        outgoing = (f"{junction}_{east}", f"{junction}_{junction}s",
                    f"{junction}_{west}", f"{junction}_{junction}n")
        for i, (inc, out) in enumerate(zip(incoming, outgoing)):
            ET.SubElement(connections, "connection", **{
                "from": inc, "to": out, "fromLane": "0", "toLane": "0",
                "tl": junction, "linkIndex": str(i)
            })
    tls = ET.Element("tlLogics")
    for junction in "ABC":
        logic = ET.SubElement(tls, "tlLogic", id=junction, type="static", programID="reference", offset="0")
        for duration, state in phase_specs():
            ET.SubElement(logic, "phase", duration=str(duration), state=state)
    # Signal linkIndex assignments belong in the tllogic input. Merely putting
    # them in a normal connections file allows netconvert to re-index them.
    for connection in connections:
        ET.SubElement(tls, "connection", **connection.attrib)
    paths = {kind: directory / f"corridor.{kind}.xml" for kind in ("nod", "edg", "con", "tll")}
    for kind, root in (("nod", nodes), ("edg", edges), ("con", connections), ("tll", tls)):
        _write(paths[kind], root)
    net_file = directory / "corridor.net.xml"
    command = [resolve_binary("netconvert"), "--node-files", str(paths["nod"]),
               "--edge-files", str(paths["edg"]), "--connection-files", str(paths["con"]),
               "--tllogic-files", str(paths["tll"]), "--no-turnarounds", "true",
               "--output-file", str(net_file)]
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError(f"netconvert failed:\n{result.stderr}\n{result.stdout}")
    compiled = ET.parse(net_file).getroot()
    for junction in "ABC":
        expected = {x.get("from"): x.get("linkIndex") for x in connections if x.get("tl") == junction}
        actual = {x.get("from"): x.get("linkIndex") for x in compiled.findall("connection")
                  if x.get("tl") == junction}
        if actual != expected:
            raise RuntimeError(f"SUMO signal link ordering differs from the configured directions at {junction}")
    routes = ET.Element("routes")
    # sigma=0 removes a stochastic car-following source and makes restored
    # counterfactual branches easier to audit; arrival randomness remains.
    ET.SubElement(routes, "vType", id="car", accel="2.6", decel="4.5", sigma="0",
                  length="5", minGap="2.5", maxSpeed="13.89", speedDev="0")
    for route, edge_ids in ROUTES.items():
        ET.SubElement(routes, "route", id=route, edges=" ".join(edge_ids))
    routes_file = directory / "definitions.rou.xml"
    _write(routes_file, routes)
    configuration = ET.Element("configuration")
    inputs = ET.SubElement(configuration, "input")
    ET.SubElement(inputs, "net-file", value=net_file.name)
    ET.SubElement(inputs, "route-files", value=routes_file.name)
    config_file = directory / "corridor.sumocfg"
    _write(config_file, configuration)
    return Network(directory, net_file, routes_file, config_file)
