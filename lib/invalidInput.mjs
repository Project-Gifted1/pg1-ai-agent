// "Fix-it" invalid-input messages (issue #215 part B, item 4). Every
// invalid-input error says what was wrong, what format is expected, one
// valid example, and the request_id - and never echoes the caller's raw
// input back (it may be very long, contain markup, or be something the
// caller didn't mean to send, e.g. a pasted secret).
//
// The error keeps whatever JSON-RPC code / MCP tool error code it already
// had (-32602 for most, the tool's own invalid_address/invalid_hostname/
// invalid_chain for isError results); only the message changes. Handlers
// throw without knowing the request_id, so `err.fixIt` carries the parts
// and the dispatcher renders the final message with invalidInputMessage().

export function formatFixIt({ problem, expected, example }, requestId) {
  const parts = [`${problem}.`, `Expected: ${expected}.`, `Example: ${example}.`];
  if (requestId) parts.push(`request_id: ${requestId}`);
  return parts.join(' ');
}

// Attaches fix-it parts to an error (a plain Error by default). Its own
// .message is the fix-it text without a request_id, for any caller that
// doesn't go through invalidInputMessage().
export function withFixIt(err, fixIt) {
  err.message = formatFixIt(fixIt);
  err.fixIt = fixIt;
  return err;
}

export function invalidInput(fixIt) {
  return withFixIt(new Error(''), fixIt);
}

// The message a dispatcher should send for `err`: the fix-it text with the
// request_id when it's an invalid-input error, otherwise err.message as-is.
export function invalidInputMessage(err, requestId) {
  return err && err.fixIt ? formatFixIt(err.fixIt, requestId) : err.message;
}
