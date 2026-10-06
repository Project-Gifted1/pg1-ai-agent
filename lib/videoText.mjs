// PG1 Motion's names and wording, with no engine code: lib/chatTools.mjs
// and lib/chatRoute.mjs import this file, and they sit on the public
// playground's import path, which must never reach a model API (the engine
// itself is lib/videoJobs.mjs, which re-exports everything here).

export const VIDEO_ENGINE_LABEL = 'PG1 Motion';
export const VIDEO_TOOL = 'generate_video';
export const MAX_VIDEO_PROMPT_CHARS = 2000;

// Wider than isVideoRequest (lib/videoJobs.mjs): a message that talks about
// making a clip in words the strict match misses ("could you show me a
// little clip of the sea?"). Such a message goes the chat tools way when
// generate_video is on offer, and the model decides whether it is a request
// (lib/chatRoute.mjs).
const VIDEO_MENTION_RE = /\b(?:videos?|clips?|animations?|animate)\b/i;
export function mentionsVideo(text) {
  return VIDEO_MENTION_RE.test(String(text || ''));
}

export function videosLeftText(remaining, cap) {
  const r = Math.max(0, Number(remaining) || 0);
  return `${r} of ${cap} video${cap === 1 ? '' : 's'} left today.`;
}
