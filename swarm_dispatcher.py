import uuid

class SwarmTaskDispatcher:
    """Handles the distribution of threat intelligence tasks to the swarm mesh."""
    
    def __init__(self, registry):
        self.registry = registry
        self.queue = []
        self.results = {}

    def submit_task(self, task_type: str, payload: dict, required_consensus: int = 1) -> str:
        task_id = str(uuid.uuid4())
        self.queue.append({
            "task_id": task_id,
            "type": task_type,
            "payload": payload,
            "required_consensus": required_consensus
        })
        print(f"[Dispatcher] Task {task_id} queued for {task_type}.")
        return task_id

    def process_queue(self):
        for task in self.queue:
            self.results[task["task_id"]] = {
                "task_type": task["type"],
                "status": "processed",
                "payload": task["payload"]
            }
        self.queue.clear()
        print("[Dispatcher] Swarm queue processed successfully.")
