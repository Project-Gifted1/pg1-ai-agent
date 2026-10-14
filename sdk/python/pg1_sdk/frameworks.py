"""Framework wrappers. No framework is a dependency.

tool_specs(client) gives {name, description, parameters (JSON Schema),
execute(args)} per PG1 tool, read live from tools/list; execute raises when
a signature does not verify (fail closed).
"""

from __future__ import annotations

import json
from typing import Any, Iterable, Optional


def tool_specs(client, only: Optional[Iterable[str]] = None) -> list:
    keep = set(only) if only else None
    specs = []
    for t in client.list_tools():
        if keep and t["name"] not in keep:
            continue

        def execute(args: Optional[dict] = None, _name: str = t["name"]) -> Any:
            r = client.call(_name, args or {})
            if "payment_required" in r:
                return {"payment_required": True, "detail": "This PG1 tool needs an x402 payment or a licence key; set a payer on PG1Client."}
            if r["verified"] is not None and not r["verified"]["valid"]:
                raise RuntimeError(f"PG1 result signature did not verify ({r['verified']['reason']})")
            return {**(r["result"] or {}), "verified": r["verified"]}

        specs.append({"name": t["name"], "description": t["description"], "parameters": t["inputSchema"], "execute": execute})
    return specs


def openai_function_tools(client, only: Optional[Iterable[str]] = None):
    """Returns (tools, run): tools for the OpenAI API, run(name, arguments_json) for its tool calls."""
    specs = {s["name"]: s for s in tool_specs(client, only)}
    tools = [{"type": "function", "function": {"name": s["name"], "description": s["description"], "parameters": s["parameters"]}} for s in specs.values()]

    def run(name: str, arguments: str) -> str:
        return json.dumps(specs[name]["execute"](json.loads(arguments or "{}")))

    return tools, run


def langchain_tools(client, StructuredTool, only: Optional[Iterable[str]] = None) -> list:
    """from langchain_core.tools import StructuredTool; recent versions accept a JSON Schema args_schema."""
    return [StructuredTool.from_function(func=lambda _s=s, **kw: json.dumps(_s["execute"](kw)), name=s["name"], description=s["description"], args_schema=s["parameters"]) for s in tool_specs(client, only)]
