import os
from supabase import create_client, Client

class SwarmRegistry:
    def __init__(self):
        self.supabase_url = os.getenv("SUPABASE_URL")
        self.supabase_service_key = os.getenv("SUPABASE_SERVICE_KEY")
        if self.supabase_url and self.supabase_service_key:
            self.supabase: Client = create_client(self.supabase_url, self.supabase_service_key)
        else:
            self.supabase = None

    def register_node(self, node_id: str, node_type: str, metadata: dict = None) -> dict:
        if not self.supabase:
            raise ValueError("Supabase client is not initialized. Check environment variables.")
        
        payload = {
            "node_id": node_id,
            "node_type": node_type,
            "metadata": metadata or {},
            "status": "active"
        }
        response = self.supabase.table("swarm_nodes").upsert(payload).execute()
        return response.data

    def get_active_nodes(self) -> list:
        if not self.supabase:
            return []
        response = self.supabase.table("swarm_nodes").select("*").eq("status", "active").execute()
        return response.data
 