"""SLM harness: rebuilds a project unit by unit with a small language model.

A planner (a large model or a person) writes a spec bundle once. This package
is the deterministic orchestrator that turns the spec into small prompts,
checks every answer, and records progress in state files.
"""

__version__ = "0.1.0"
