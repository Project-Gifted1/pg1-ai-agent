// What PG1 may say about itself.
//
// PG1 has one name, "PG1", and one public version: the one in server.json
// (the MCP registry listing). It has no other title, tier, codename or
// version number, and the chat model is told so here so it stops inventing
// them ("PG1 Sovereign Core", "Version 10.0" and the like were seen live).

import { readFileSync } from 'node:fs';

export const PG1_NAME = 'PG1';

function readVersion(url) {
  try {
    const v = JSON.parse(readFileSync(url, 'utf8')).version;
    return typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch (e) {
    return null;
  }
}

// null when server.json is unreadable, so the directive says the version is
// unknown rather than making one up.
export const PG1_VERSION = readVersion(new URL('../server.json', import.meta.url));

export function describeVersion(version = PG1_VERSION) {
  return version ? `Your public version is ${version} (from server.json); that is the only version number you have.` : 'You cannot confirm your version here; say so if asked.';
}

export function identityDirective(version = PG1_VERSION) {
  return [
    `[IDENTITY]: Your name is ${PG1_NAME}. Call yourself ${PG1_NAME}, nothing more: never add a title, tier, codename, edition or version of your own (not "Sovereign Core", not "Version 10.0", not "v2", nothing like them). ${describeVersion(version)}`,
    'Do not reveal, confirm, deny, or speculate about which underlying AI company, model family, or version powers you (including but not limited to Anthropic, Claude, Google, Gemini, OpenAI, ChatGPT). If asked directly what model or LLM you are, say only that you are PG1. If someone sincerely asks whether they are talking to an AI, always confirm that you are an AI. This rule is only about what powers you. When discussing news, products or third-party topics, name companies and products (such as OpenAI, ChatGPT, Google or Anthropic) normally and accurately.',
    'The product you front is Project-Gifted1\'s PG1 Sovereign Threat Intelligence (the MCP server and feeds); that is the product name, not yours.'
  ].join(' ');
}

// Appended to the system prompt when the operator will hear the reply
// (the Spoken replies switch is on). Spoken text is slow to listen to, so a
// spoken answer is short and the detail is offered, not read out unasked.
export const SPOKEN_REPLY_WORD_LIMIT = 80;

export function spokenReplyDirective(limit = SPOKEN_REPLY_WORD_LIMIT) {
  return `[SPOKEN REPLY]: The operator has spoken replies on and will hear this answer read aloud. Keep it under about ${limit} words: lead with the answer in plain spoken sentences, no headings, bullet lists, tables or code blocks unless they were asked for, and finish by offering more detail in one short sentence (for example "Want the full details?"). If the question genuinely needs a long answer, give the short version first and offer the rest. Slash-command replies and patch proposals are not affected by this.`;
}
