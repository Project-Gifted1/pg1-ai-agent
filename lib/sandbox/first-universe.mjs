// PG1's first universe: world aba0e1ed-5d32-40c6-a1e2-ca876ba84a91.
//
// It is only ever improved in place (/sandbox upgrade: quality, never its
// tick or its inhabitants). Never deleted, never given a new start from a
// template, never reset, by any route: the chat commands, the agents' tools
// (MCP delete_world) or the store. Besides that id, PG1's oldest world is
// treated the same (on a deployment whose store does not hold that id, the
// oldest world is the first universe).
//
//   FIRST_UNIVERSE_ID
//   isFirstUniverse(world, oldest)   true for the id, or for PG1's oldest world

export const FIRST_UNIVERSE_ID = 'aba0e1ed-5d32-40c6-a1e2-ca876ba84a91';

export function isFirstUniverse(world, oldest = null) {
  if (!world) return false;
  const id = String(world.id || world || '').toLowerCase();
  if (id === FIRST_UNIVERSE_ID) return true;
  return !!(oldest && oldest.id && String(oldest.id).toLowerCase() === id);
}
