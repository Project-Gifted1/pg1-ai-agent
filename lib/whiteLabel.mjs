// Item 10, white label: client-facing output (chat offers, proposals, PDFs,
// package pages, notifications to clients) never names a provider or a
// model. It says "PG1 Studio" (video and images) or "PG1 Sound" (music and
// voice) and describes what the capability does. Provider names stay in
// the capability registry, reports and operator-only views.
//
//   PROVIDER_NAME_RE      every provider, company and model name PG1 uses or
//                         researched, and model id shapes (vendor/model,
//                         gemini-…, eleven_…)
//   namesProvider(text)   whether a text names one
//   whiteLabel(text)      the same text with each name replaced by the PG1
//                         label for what it does, and the leftovers of the
//                         replacement tidied ("PG1 Studio on the provider"
//                         → "PG1 Studio")
//   isOfferRequest(text)  whether the operator is asking for an offer,
//                         package, quote or proposal (a chat reply to it is
//                         client-facing and is white-labelled)

export const STUDIO_LABEL = 'PG1 Studio';

// The trademark. PG1 Studio and PG1 Sound are services of Project-Gifted1™;
// every client-facing offer and document carries the mark, written exactly
// this way (the form the site, the docs footers and the app title use).
export const TRADEMARK = 'Project-Gifted1™';
export const BRAND_LINE = `PG1 Studio and PG1 Sound are services of ${TRADEMARK}.`;
// Not inside a URL or path (github.com/Project-Gifted1/...), which must stay
// byte for byte.
const TRADEMARK_RE = /(?<![\w/.@-])Project[\s-]?Gifted\s?1(?:\s?(?:™|\(TM\)|&trade;|\u2122))?(?![\w/-])/gi;

// Every mention of the company written as the mark ("Project Gifted1",
// "Project-Gifted1 (TM)" -> "Project-Gifted1™").
export function withTrademark(text) {
  return String(text == null ? '' : text).replace(TRADEMARK_RE, TRADEMARK);
}

export function hasTrademark(text) {
  return String(text || '').includes(TRADEMARK);
}
export const SOUND_LABEL = 'PG1 Sound';
// A company or platform is "the provider": saying PG1 instead would put
// the provider's words ("won't claim ownership") in PG1's mouth.
export const PROVIDER_LABEL = 'the provider';

// [pattern, label]. Longer names first so "Eleven Music" is replaced whole.
const NAMES = [
  // model ids and slugs
  [String.raw`[a-z0-9][a-z0-9-]*\/(?:kling|veo|lyria|flux|wan|imagen|demucs|real-esrgan|frame-interpolation|rife|video-upscale|image-upscale|chatterbox|whisper|sonic)[a-z0-9._-]*`, null],
  [String.raw`gemini-[a-z0-9.-]+`, null],
  [String.raw`(?:veo|lyria|imagen)-[a-z0-9.-]+`, null],
  [String.raw`eleven_[a-z0-9_]+`, SOUND_LABEL],
  [String.raw`(?:flux-)?kontext-[a-z]+`, STUDIO_LABEL],
  [String.raw`sonic-\d[\d.]*`, SOUND_LABEL],
  // sound
  [String.raw`Eleven\s?Labs|Eleven\s+Music|Eleven\s+v\d(?:\s+Turbo)?|Eleven\s+Multilingual(?:\s+v\d)?|ElevenAPI|Eleven\s+Flash`, SOUND_LABEL],
  [String.raw`Lyria(?:\s+(?:RealTime|\d(?:\.\d)?(?:\s+(?:Pro|Clip))?))?`, SOUND_LABEL],
  [String.raw`Cartesia|Demucs|htdemucs|basic-pitch|Chirp(?:\s+\d)?(?:\s+Instant\s+Custom\s+Voice)?|Whisper|Chatterbox|Resemble(?:\s+AI)?|SynthID`, SOUND_LABEL],
  // studio
  [String.raw`Gemini\s+Omni(?:\s+\d(?:\.\d)?)?(?:\s+Flash)?|Omni\s+(?:\d(?:\.\d)?\s+)?Flash|Veo(?:\s+\d(?:\.\d)?)?(?:\s+(?:Fast|Lite))?|Imagen(?:\s+\d)?(?:\s+(?:Fast|Ultra))?|Nano\s+Banana(?:\s+\d)?(?:\s+Lite)?`, STUDIO_LABEL],
  [String.raw`Kling(?:\s+v?\d(?:\.\d)?)?(?:\s+(?:Turbo|Pro|Master))*|Kuaishou|kwaivgi|Topaz(?:\s+Labs)?|Astra|FLUX(?:\.\d)?(?:\s+(?:Kontext|Schnell|Pro|Dev))*(?:\s+\[[a-z]+\])?|Kontext|Black\s+Forest\s+Labs|BFL|Wan(?:\s+\d\.\d)|Alibaba|Real-?ESRGAN|RIFE|Stable\s+Diffusion|Stability\s+AI|Runway|Sora|Pika|Luma`, STUDIO_LABEL],
  // platforms and companies
  [String.raw`Google(?:\s+(?:DeepMind|AI|Cloud|Gemini))?|DeepMind|Gemini(?:\s+API)?|Vertex(?:\s+AI)?|Replicate|Anthropic|Claude|OpenAI|ChatGPT|GPT-?\d[\w.-]*|OpenRouter|Hugging\s?Face|FFmpeg|Supabase|Vercel|Cloudflare(?:\s+R2)?|Backblaze|Wasabi|Amazon\s+S3|AWS`, PROVIDER_LABEL]
];

const nameSource = NAMES.map(([p]) => `(?:${p})`).join('|');
export const PROVIDER_NAME_RE = new RegExp(String.raw`(?<![A-Za-z0-9_])(?:${nameSource})(?![A-Za-z0-9_])`, 'i');
const COMPILED = NAMES.map(([p, label]) => [new RegExp(String.raw`(?<![A-Za-z0-9_])(?:${p})(?![A-Za-z0-9_])`, 'gi'), label]);

export function namesProvider(text) {
  return PROVIDER_NAME_RE.test(String(text || ''));
}

// The label for a model id: by what it makes.
function labelForId(id) {
  return /lyria|demucs|whisper|chatterbox|sonic|tts|eleven/i.test(id) ? SOUND_LABEL : STUDIO_LABEL;
}

const LABEL_RE = String.raw`PG1(?:\s+(?:Studio|Sound))?`;

const URL_RE = /https?:\/\/[^\s)>\]]+/g;
const hostNamesProvider = (url) => {
  try { return namesProvider(new URL(url).hostname.replace(/\./g, ' ')); } catch (e) { return false; }
};

// Links to a provider's own site: a Markdown link keeps its text, a bare
// URL goes. Other links are kept as they are.
export function stripProviderLinks(text) {
  return String(text == null ? '' : text)
    .replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (m, label, url) => (hostNamesProvider(url) ? label : m))
    .replace(URL_RE, (url) => (hostNamesProvider(url) ? '' : url))
    .replace(/(?<![\w@/.-])(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|ai|io|dev|google|net|org|co|app)(?![\w.-])/gi, (d) => (hostNamesProvider(`https://${d}`) ? 'the provider\'s site' : d));
}

// Whether a search source points at a provider's own site.
export function providerSource(source) {
  return !!source && (hostNamesProvider(source.url || '') || namesProvider(String(source.title || '')));
}

export function whiteLabel(text) {
  let t = stripProviderLinks(text);
  if (!namesProvider(t.replace(URL_RE, ' '))) return t;
  // URLs that stay (not a provider's) are kept byte for byte.
  const urls = [];
  t = t.replace(URL_RE, (u) => { urls.push(u); return `\u0000${urls.length - 1}\u0000`; });
  // A provider's own terms are "provider terms", never PG1's.
  t = t.replace(new RegExp(String.raw`(?<![A-Za-z0-9_])(?:${nameSource})(?:['’]s)?(?:\s+(?:own|generated[- ]content|API|Additional))*\s+(terms(?:\s+of\s+(?:service|use))?|licen[cs]es?|polic(?:y|ies))\b`, 'gi'), 'provider $1');
  for (const [re, label] of COMPILED) t = t.replace(re, (m) => label || labelForId(m));
  // Tidy what the replacement leaves: "PG1 Studio on PG1", "PG1 Sound (PG1
  // Sound)", "PG1 Studio, PG1 Studio and PG1 Sound", "PG1 Studio's PG1 Studio".
  const tidy = [
    [new RegExp(String.raw`(${LABEL_RE})(\s+(?:models?|engines?|API))?\s+(?:on|via|through|from|by|using|with|in|hosted\s+on)\s+(?:the\s+)?the provider(?:['’]s)?(?:\s+(?:API|platform|models?|engines?))?`, 'g'), '$1$2'],
    [new RegExp(String.raw`the provider(?:['’]s)?\s+(${LABEL_RE})`, 'g'), '$1'],
    [/\bthe\s+the provider\b/gi, 'the provider'],
    [/\bthe provider\s+(?:and|,|\/)\s+the provider\b/g, 'the provider'],
    [new RegExp(String.raw`(${LABEL_RE})\s*\(\s*(?:${LABEL_RE})\s*\)`, 'g'), '$1'],
    [new RegExp(String.raw`(${LABEL_RE})(?:['’]s)?\s+\1\b`, 'g'), '$1'],
    [new RegExp(String.raw`(${LABEL_RE})((?:\s*(?:,|and|or|\/|&)\s*\1\b)+)`, 'g'), '$1'],
    [/PG1 Studio(?:\s*(?:,|and|or|\/|&)\s*PG1 Sound)\b/g, 'PG1 Studio and PG1 Sound']
  ];
  for (let i = 0; i < 3; i++) for (const [re, to] of tidy) t = t.replace(re, to);
  t = t.replace(/(^[ \t]*(?:[-*•+]\s+|\d+[.)]\s+|#+\s+)?|[.!?:]\s+|\|\s*)the provider/gm, '$1The provider');
  return t.replace(/\u0000(\d+)\u0000/g, (m, i) => urls[Number(i)]);
}

// Whether `head` ends on a word that can start a longer name ("Eleven" of
// "Eleven Music", "Veo" of "Veo 3.1"), so a stream should not cut there.
const NAME_START_RE = /(?:^|\s)(?:eleven|black|forest|google|gemini|omni|veo|lyria|kling|imagen|flux|nano|stable|stability|hugging|amazon|topaz|resemble|chirp|wan|real-?esrgan|sonic|cartesia|elevenlabs|replicate)\s*$/i;
export function splitsName(head) {
  return NAME_START_RE.test(String(head || ''));
}

// The operator asking for something a client will see: an offer, package,
// quote, proposal, price list, pitch or rate card.
const OFFER_RE = /\b(?:offers?|packages?|quotes?|quotations?|proposals?|pricing|price\s+list|rate\s+card|tiers?|pitch|brochure|one[- ]pager|for\s+(?:a|the|my|our)\s+clients?|client[- ]facing)\b/i;
export function isOfferRequest(text) {
  const t = String(text || '');
  return !/^\s*\//.test(t) && OFFER_RE.test(t);
}
