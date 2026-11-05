// /security commands in chat (signed-in operator only; api/chat.mjs gates
// every slash command before this runs):
//
//   /security                     what is set up: passkeys, the recovery switch
//   /security passkeys            the passkeys, with an id to remove each
//   /security passkey remove <id> removes one (id, id prefix or exact name)
//                                 and ends the sessions it started
//   /security signout-all         ends every session but this one
//   /security passkey add         runs in the page (it needs the phone's
//                                 passkey prompt, public/security/passkey.js);
//                                 a request that reaches the server (a relay,
//                                 a script) gets told to use the page.
//
// Replies never hold a credential ID, a public key or an IP.

import { listPasskeys, removePasskey, signOutOthers, recoveryOn, RECOVERY_ENV } from './auth.mjs';
import { securityStore } from './store.mjs';

export function isSecurityCommand(lower) {
  return /^\/security(?:\s|$)/.test(String(lower || '').trim().toLowerCase());
}

const when = (iso) => (iso ? String(iso).slice(0, 16).replace('T', ' ') + ' UTC' : 'never');

function passkeyLines(list) {
  return list.map((p) => `- **${p.name}** (${p.device || 'device unknown'}${p.synced ? ', synced' : ''}): added ${when(p.createdAt)}, last used ${when(p.lastUsedAt)}. Remove: \`/security passkey remove ${String(p.id).slice(0, 8)}\``);
}

// { status, reply, actions? }. session: the caller's session row (from
// authenticateOperator), so signout-all keeps it.
export async function handleSecurityCommand({ text, session = null, env = process.env, store = securityStore(), now = Date.now }) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  const lower = t.toLowerCase();
  const recovery = recoveryOn(env);
  try {
    if (lower === '/security passkey add' || lower === '/security passkeys add') {
      return { status: 200, reply: 'Adding a passkey needs your phone\'s passkey prompt: send **/security passkey add** from the PG1 page while signed in.', passkeyAdd: true };
    }
    if (lower === '/security signout-all') {
      const r = await signOutOthers(session ? session.idHash : null, { store, now });
      const n = r.ended;
      return { status: 200, reply: n ? `Signed out ${n} other session${n === 1 ? '' : 's'}. ${session ? 'This one stays signed in.' : ''}`.trim() : `No other sessions were signed in.${session ? ' This one stays signed in.' : ''}` };
    }
    const rm = /^\/security passkeys? (?:remove|delete) (.+)$/i.exec(t);
    if (rm) {
      const r = await removePasskey(rm[1], { store, now });
      if (!r.ok) return { status: 200, reply: r.reason === 'ambiguous' ? 'More than one passkey matches. Use more of its id (see **/security passkeys**).' : 'No passkey matches that. See **/security passkeys** for the ids.' };
      const tail = r.remaining === 0
        ? ' That was the last passkey: the password signs in again.'
        : '';
      return { status: 200, reply: `Removed **${r.passkey.name}**.${r.endedSessions ? ` Ended ${r.endedSessions} session${r.endedSessions === 1 ? '' : 's'} it started.` : ''}${tail}` };
    }
    if (lower === '/security passkeys' || lower === '/security passkey' || lower === '/security passkey list' || lower === '/security') {
      const list = await listPasskeys({ store });
      if (!list.length) {
        return { status: 200, reply: 'No passkeys yet: the password signs you in. Send **/security passkey add** from your phone to add one; from then on, sign-in needs the passkey.', actions: [{ label: 'Add a passkey', command: '/security passkey add', kind: 'command', confirm: false }] };
      }
      const head = `${list.length} passkey${list.length === 1 ? '' : 's'}. ${recovery ? `Password recovery is ON (${RECOVERY_ENV}): the password also signs in. Turn it off in Vercel once you have a passkey again.` : 'The password alone does not sign in.'}`;
      return { status: 200, reply: [head, '', ...passkeyLines(list), '', 'Add another with **/security passkey add**. **/security signout-all** ends every other session.'].join('\n') };
    }
    return { status: 200, reply: 'Security commands: **/security passkeys**, **/security passkey add**, **/security passkey remove <id>**, **/security signout-all**.' };
  } catch (e) {
    return { status: 200, reply: 'Sign-in settings are not available right now. Try again in a minute.' };
  }
}
