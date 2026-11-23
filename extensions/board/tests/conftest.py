"""Loads l0wagent's hub-services test world (control/tests/hubworld.py: a joined fake hub, a real control app) by path, so this
folder's own `tests` package doesn't clash with control's."""

import importlib.util
import os
import sys
from pathlib import Path

os.environ.setdefault("L0W_SCHEDULER", "0")
os.environ.setdefault("L0W_AGENT_API_ANY_ADDRESS", "1")

HUBWORLD = Path(os.environ.get("L0W_CONTROL_TESTS", Path(__file__).resolve().parents[6] / "l0wagent" / "control" / "tests")) / "hubworld.py"
_spec = importlib.util.spec_from_file_location("l0w_hubworld", HUBWORLD)
assert _spec and _spec.loader, HUBWORLD
hubworld = importlib.util.module_from_spec(_spec)
sys.modules["l0w_hubworld"] = hubworld
_spec.loader.exec_module(hubworld)

hw = hubworld.hw  # the fixture
