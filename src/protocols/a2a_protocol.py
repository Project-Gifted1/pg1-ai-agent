"""
Agent-to-Agent (A2A) Autonomous Protocol & Message Dispatcher
Project: PG1 Autonomous Agent Architecture
"""

import json
import uuid
import time
from typing import Dict, Any, Optional, List


class A2AMessage:
    """Standardized message schema for Agent-to-Agent communication."""
    
    def __init__(
        self,
        sender: str,
        recipient: str,
        action: str,
        payload: Dict[str, Any],
        task_id: Optional[str] = None,
        protocol_version: str = "2.0.0"
    ):
        self.task_id = task_id or f"task_{uuid.uuid4().hex[:8]}"
        self.sender = sender
        self.recipient = recipient
        self.action = action
        self.payload = payload
        self.protocol_version = protocol_version
        self.timestamp = time.time()

    def to_dict(self) -> Dict[str, Any]:
        return {
            "protocol_version": self.protocol_version,
            "task_id": self.task_id,
            "timestamp": self.timestamp,
            "sender": self.sender,
            "recipient": self.recipient,
            "action": self.action,
            "payload": self.payload
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "A2AMessage":
        return cls(
            sender=data.get("sender", "unknown"),
            recipient=data.get("recipient", "broadcast"),
            action=data.get("action", "query"),
            payload=data.get("payload", {}),
            task_id=data.get("task_id"),
            protocol_version=data.get("protocol_version", "2.0.0")
        )


class A2ACapabilityRegistry:
    """Registry managing peer agent capabilities and endpoint routing."""

    def __init__(self):
        self._registry: Dict[str, Dict[str, Any]] = {}

    def register_agent(self, agent_id: str, capabilities: List[str], endpoint: str = "local"):
        self._registry[agent_id] = {
            "capabilities": capabilities,
            "endpoint": endpoint,
            "registered_at": time.time(),
            "status": "active"
        }

    def find_agent_for_capability(self, capability: str) -> Optional[str]:
        for agent_id, info in self._registry.items():
            if capability in info.get("capabilities", []) and info.get("status") == "active":
                return agent_id
        return None

    def list_agents(self) -> Dict[str, Dict[str, Any]]:
        return self._registry


class A2ARouter:
    """Dispatches messages between autonomous sub-agents and manages feedback loops."""

    def __init__(self, agent_id: str):
        self.agent_id = agent_id
        self.registry = A2ACapabilityRegistry()
        self.inbox: List[A2AMessage] = []
        self.outbox: List[A2AMessage] = []

    def dispatch(self, message: A2AMessage) -> Dict[str, Any]:
        """Routes a message to the designated recipient or handles local resolution."""
        self.outbox.append(message)
        
        # Check if recipient is local agent or registered peer
        target = message.recipient
        if target == self.agent_id or target == "local":
            return self._handle_local_action(message)
        
        # Look up capabilities for dynamic dispatch
        agent_id = self.registry.find_agent_for_capability(message.action)
        if agent_id:
            return {
                "status": "routed",
                "task_id": message.task_id,
                "target_agent": agent_id,
                "timestamp": time.time()
            }
        
        return {
            "status": "queued",
            "task_id": message.task_id,
            "message": f"Recipient '{target}' or capability '{message.action}' queued for execution."
        }

    def _handle_local_action(self, message: A2AMessage) -> Dict[str, Any]:
        """Handles actions assigned to self."""
        return {
            "status": "completed",
            "task_id": message.task_id,
            "executor": self.agent_id,
            "result": {
                "acknowledged": True,
                "action": message.action,
                "processed_payload": message.payload
            }
        }
