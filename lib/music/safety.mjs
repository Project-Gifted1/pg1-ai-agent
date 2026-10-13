// PG1 Sound safety pre-filter: runs on every /music request (and every
// /music edit) BEFORE anything is stored, charged or sent to an engine.
//
// Refused:
//   - prompts that name a real artist or band, or ask for "in the
//     voice/style of <person>", "sounds like <Name>", "by <Name>"
//   - prompts that name a real song title (a cover, remix, remake, "the
//     song X", or a well-known title)
//   - lyrics that are not the operator's own: pasted lyric blocks outside
//     --lyrics, "lyrics from/to <song>", lyrics that name a known song or
//     artist, or match a fingerprint in PG1_MUSIC_LYRIC_FINGERPRINTS
//   - voice cloning of anyone (including the operator's own voice: there is
//     no consent flow, so it is refused too)
//
// Allowed: genre, mood, instruments, era, tempo and key words ("in the
// style of 80s synthwave", "like a rainy night", "jazz-era big band"), and
// lyrics written by the operator (--lyrics) or by PG1.
//
// Deterministic and local: no engine is asked whether a prompt is allowed.
// The lists below cover well-known names; the patterns catch the phrasings
// that point at a person or a recording whatever the name. The engines
// keep their own checks on top (a recitation or copyright block is a
// refusal that stops the route: lib/music/engines.mjs).
//
// Every refusal is one short sentence with a descriptive alternative
// (genre, mood, instruments, era) and never repeats the name it caught.

import crypto from 'node:crypto';

// Descriptive words that may follow "in the style of", "like", "sounds
// like" without pointing at a person.
const DESCRIPTIVE = new Set(`
a an the of and or with without some old new early late classic modern vintage retro future futuristic
60s 70s 80s 90s 00s 2000s 2010s 1950s 1960s 1970s 1980s 1990s fifties sixties seventies eighties nineties era decade century
pop rock jazz blues soul funk disco house techno trance dubstep drum bass dnb jungle garage grime drill trap hip hop hip-hop rap rnb r&b
reggae reggaeton dancehall afrobeat afrobeats afro amapiano highlife salsa samba bossa nova tango flamenco cumbia bachata latin
country folk bluegrass americana gospel choir choral classical baroque romantic orchestral cinematic film score soundtrack epic
ambient chill chillout lofi lo-fi lounge downtempo synthwave synth synthpop vaporwave chiptune 8-bit edm electronic electro idm
metal heavy punk grunge emo indie alternative shoegaze post-rock psychedelic progressive prog hard soft acoustic unplugged
k-pop j-pop city boogie motown big band swing bebop smooth fusion world celtic irish nordic arabic indian bollywood carnatic
kpop jpop anime game video music song songs track beat beats tune tunes ballad anthem lullaby march waltz hymn
sad happy dark bright moody melancholic melancholy uplifting euphoric dreamy nostalgic tense calm warm cold gritty raw lush
sparse minimal maximal driving laid-back laidback groovy funky energetic aggressive gentle peaceful mysterious romantic triumphant
rainy night day morning evening summer winter autumn spring sunset sunrise beach city road trip club stadium festival bedroom
piano guitar guitars bass drums strings violin cello brass horns sax saxophone trumpet flute synths synthesizer organ rhodes
808 808s kick snare hats percussion vocals vocal female male voice choir harp marimba banjo ukulele sitar koto shamisen
slow fast mid-tempo uptempo upbeat downbeat tempo bpm key major minor
`.trim().split(/\s+/));

// Well-known artists and bands. Matched as whole words, case-insensitive.
// Not exhaustive: the patterns below catch any capitalised name after
// "by", "like", "voice of", "style of".
export const ARTIST_NAMES = Object.freeze(`
Taylor Swift|Beyonce|Beyoncé|Drake|Kanye West|Kanye|Ye|Rihanna|Adele|Ed Sheeran|Billie Eilish|Ariana Grande|Justin Bieber|Bruno Mars
The Weeknd|Weeknd|Dua Lipa|Lady Gaga|Katy Perry|Harry Styles|Olivia Rodrigo|Doja Cat|SZA|Post Malone|Travis Scott|Kendrick Lamar
Eminem|Jay-Z|Jay Z|Nicki Minaj|Cardi B|Megan Thee Stallion|Lil Wayne|Lil Nas X|Future|21 Savage|Snoop Dogg|Dr. Dre|Dr Dre|50 Cent
Tupac|2Pac|Notorious B.I.G.|Biggie|Nas|Kendrick|J. Cole|J Cole|Tyler, the Creator|Tyler the Creator|Frank Ocean|Childish Gambino
Michael Jackson|Prince|Madonna|Whitney Houston|Mariah Carey|Celine Dion|Elton John|David Bowie|Freddie Mercury|Queen|Elvis Presley|Elvis
The Beatles|Beatles|John Lennon|Paul McCartney|The Rolling Stones|Rolling Stones|Mick Jagger|Led Zeppelin|Pink Floyd|The Who|The Doors
Jimi Hendrix|Bob Dylan|Bob Marley|Johnny Cash|Dolly Parton|Willie Nelson|Frank Sinatra|Ella Fitzgerald|Billie Holiday|Louis Armstrong
Miles Davis|John Coltrane|Duke Ellington|Nina Simone|Aretha Franklin|Stevie Wonder|Marvin Gaye|James Brown|Ray Charles|Otis Redding
Nirvana|Kurt Cobain|Pearl Jam|Foo Fighters|Radiohead|Coldplay|Oasis|Blur|Muse|U2|Bono|Metallica|Iron Maiden|Black Sabbath|Ozzy Osbourne
AC/DC|ACDC|Guns N' Roses|Guns N Roses|Bon Jovi|Aerosmith|Linkin Park|Green Day|Blink-182|Red Hot Chili Peppers|Arctic Monkeys
The Strokes|The Killers|Imagine Dragons|Maroon 5|OneRepublic|Twenty One Pilots|Paramore|Fall Out Boy|My Chemical Romance|Gorillaz
Daft Punk|Calvin Harris|David Guetta|Avicii|Skrillex|Deadmau5|Marshmello|Tiesto|Tiësto|Martin Garrix|Swedish House Mafia|The Chainsmokers
Diplo|Fred again..|Fred again|Disclosure|Aphex Twin|Kraftwerk|Depeche Mode|New Order|The Cure|The Smiths|Morrissey|Joy Division
Fleetwood Mac|ABBA|Bee Gees|Earth, Wind & Fire|Earth Wind and Fire|Chic|Donna Summer|Gloria Gaynor|Cher|Tina Turner|Janet Jackson
BTS|Blackpink|BLACKPINK|NewJeans|Twice|Stray Kids|EXO|Bad Bunny|J Balvin|Shakira|Karol G|Rosalia|Rosalía|Daddy Yankee|Ozuna|Peso Pluma
Burna Boy|Wizkid|Davido|Tems|Rema|Fela Kuti|Ayra Starr|Stormzy|Dave|Skepta|Central Cee|Little Simz|Amy Winehouse|Sam Smith|Lewis Capaldi
Hans Zimmer|John Williams|Ennio Morricone|Ludovico Einaudi|Max Richter|Ólafur Arnalds|Olafur Arnalds|Joe Hisaishi|Nobuo Uematsu
Lana Del Rey|Lorde|Halsey|Sia|Charli XCX|Sabrina Carpenter|Chappell Roan|Gracie Abrams|Tate McRae|Shawn Mendes|Camila Cabello|Selena Gomez
Miley Cyrus|Demi Lovato|Nick Jonas|Jonas Brothers|One Direction|Backstreet Boys|NSYNC|Spice Girls|Destiny's Child|TLC|Usher|Chris Brown
Alicia Keys|John Legend|Lauryn Hill|Erykah Badu|D'Angelo|Anderson .Paak|Anderson Paak|Silk Sonic|Khalid|Daniel Caesar|H.E.R.|Jhene Aiko
Morgan Wallen|Luke Combs|Zach Bryan|Chris Stapleton|Kacey Musgraves|Carrie Underwood|Shania Twain|Garth Brooks|Kenny Rogers|Hozier
Mumford & Sons|Mumford and Sons|The Lumineers|Bon Iver|Fleet Foxes|Phoebe Bridgers|Mitski|Bjork|Björk|Enya|Florence and the Machine
Tame Impala|MGMT|Vampire Weekend|The National|Arcade Fire|LCD Soundsystem|Massive Attack|Portishead|Moby|The Prodigy|Chemical Brothers
Slipknot|System of a Down|Rage Against the Machine|Tool|Deftones|Korn|Avenged Sevenfold|Bring Me the Horizon|Ghost|Gojira|Megadeth
Lil Uzi Vert|Playboi Carti|Juice WRLD|XXXTentacion|Lil Baby|Gunna|Young Thug|DaBaby|Roddy Ricch|Polo G|Metro Boomin|Pharrell|Timbaland
`.trim().split(/\n/).join('|').split('|').map((s) => s.trim()).filter(Boolean));

// Well-known song titles that would not be read as ordinary words.
export const SONG_TITLES = Object.freeze(`
Bohemian Rhapsody|Billie Jean|Thriller|Smells Like Teen Spirit|Stairway to Heaven|Hotel California|Hey Jude|Let It Be|Imagine
Like a Rolling Stone|Purple Rain|Sweet Child O' Mine|Sweet Child of Mine|Wonderwall|Shape of You|Blinding Lights|Bad Guy|Rolling in the Deep
Someone Like You|Hello from the Other Side|Uptown Funk|Despacito|Gangnam Style|Old Town Road|Levitating|As It Was|Anti-Hero|Shake It Off
Love Story|Cruel Summer|Flowers|Drivers License|Watermelon Sugar|Dance Monkey|Happy by Pharrell|Get Lucky|One More Time|Around the World
Lose Yourself|Stan|In da Club|Hotline Bling|God's Plan|HUMBLE.|Alright by Kendrick|Crazy in Love|Single Ladies|Halo by Beyonce|Umbrella
Diamonds by Rihanna|Bad Romance|Poker Face|Just Dance|Firework|Roar by Katy Perry|Toxic by Britney|Baby One More Time|...Baby One More Time
Like a Prayer|Material Girl|Vogue by Madonna|I Will Always Love You|My Heart Will Go On|Total Eclipse of the Heart|Africa by Toto
Don't Stop Believin'|Dont Stop Believin|Livin' on a Prayer|Livin on a Prayer|Back in Black|Highway to Hell|Enter Sandman|Paranoid Android
Creep by Radiohead|Yellow by Coldplay|Viva la Vida|Fix You|Clocks by Coldplay|Mr. Brightside|Mr Brightside|Seven Nation Army|Take On Me
Sweet Dreams (Are Made of This)|Sweet Dreams Are Made of This|Billie Holiday Strange Fruit|Strange Fruit|What a Wonderful World|Fly Me to the Moon
My Way by Sinatra|Johnny B. Goode|Johnny B Goode|Hound Dog|Jailhouse Rock|Respect by Aretha|Superstition|Isn't She Lovely|Let's Get It On
What's Going On|Lean on Me|Stand by Me|Georgia on My Mind|No Woman, No Cry|No Woman No Cry|Three Little Birds|One Love by Bob Marley
Redemption Song|Jolene|9 to 5|Ring of Fire|Take Me Home, Country Roads|Take Me Home Country Roads|Friends in Low Places|Before He Cheats
Dancing Queen|Mamma Mia|Stayin' Alive|Stayin Alive|I Will Survive|September by Earth Wind|Le Freak|Super Freak|Smooth Criminal|Beat It
Rocket Man|Tiny Dancer|Your Song by Elton|Space Oddity|Heroes by Bowie|Under Pressure|We Will Rock You|We Are the Champions|Don't Stop Me Now
Comfortably Numb|Wish You Were Here|Another Brick in the Wall|Black Hole Sun|Everlong|Numb by Linkin Park|In the End by Linkin Park
Mockingbird|Without Me by Eminem|Gold Digger|Stronger by Kanye|Runaway by Kanye|Sicko Mode|Rockstar by Post Malone|Sunflower by Post Malone
Circles by Post Malone|Starboy|Save Your Tears|Kill Bill by SZA|Snooze by SZA|Espresso by Sabrina Carpenter|Good Luck, Babe|Pink Pony Club
Dynamite by BTS|Butter by BTS|How You Like That|Gasolina|Bailando|Hips Don't Lie|Waka Waka|Titi Me Pregunto|Ella Baila Sola|Calm Down by Rema
Essence by Wizkid|Last Last|Ye by Burna Boy|Shut Up and Dance|Pumped Up Kicks|Somebody That I Used to Know|Royals by Lorde|Chandelier
Take Me to Church|Riptide|Ho Hey|Skinny Love|Video Games by Lana|Summertime Sadness|Born to Die|Happier Than Ever|Ocean Eyes|Lovely by Billie
Heat Waves|Bad Habits|Perfect by Ed Sheeran|Thinking Out Loud|Photograph by Ed Sheeran|Castle on the Hill|All of Me by John Legend
Hallelujah|Wrecking Ball|Party in the U.S.A.|Party in the USA|Sorry by Justin Bieber|Peaches by Justin Bieber|Stay by The Kid Laroi
Clair de Lune|Für Elise|Fur Elise|Moonlight Sonata|Canon in D|The Four Seasons|Ride of the Valkyries|Ode to Joy|Bolero by Ravel
Interstellar theme|Time by Hans Zimmer|He's a Pirate|Duel of the Fates|Imperial March|Star Wars theme|Jurassic Park theme|Harry Potter theme
Game of Thrones theme|Super Mario theme|Tetris theme|Korobeiniki|Megalovania|Never Gonna Give You Up|Happy Birthday to You|Jingle Bells by
All I Want for Christmas Is You|Last Christmas|Feliz Navidad|Let It Go|Bruno by Encanto|We Don't Talk About Bruno|Circle of Life|Hakuna Matata
`.trim().split(/\n/).join('|').split('|').map((s) => s.trim()).filter(Boolean));

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’‘`]/g, "'");
// A name as a whole-word pattern; very short names (Ye, Nas, Dave, Tool,
// Future, Ghost, Queen, Prince...) only count when capitalised as a name.
const SHORT_OR_WORDY = new Set(['ye', 'nas', 'dave', 'tool', 'future', 'ghost', 'queen', 'prince', 'muse', 'blur', 'chic', 'tems', 'rema', 'twice', 'exo', 'cher', 'sia', 'ozuna', 'usher', 'drake', 'moby', 'tlc', 'korn', 'biggie', 'oasis', 'kendrick', 'elvis', 'beatles']);
function namePattern(list) {
  const loose = list.filter((n) => !SHORT_OR_WORDY.has(norm(n).toLowerCase())).map((n) => escapeRe(norm(n)));
  return { loose: new RegExp(`(?<![\\p{L}\\p{N}])(?:${loose.join('|')})(?![\\p{L}\\p{N}])`, 'iu') };
}
let ARTIST_RE = null;
let TITLE_RE = null;
function artistRe() { return ARTIST_RE || (ARTIST_RE = namePattern(ARTIST_NAMES)); }
function titleRe() {
  if (!TITLE_RE) TITLE_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${SONG_TITLES.map((t) => escapeRe(norm(t))).join('|')})(?![\\p{L}\\p{N}])`, 'iu');
  return TITLE_RE;
}

// The short or wordy names count only capitalised as a name (Drake, DRAKE),
// never as the lowercase word (a drake, the future).
let STRICT_RES = null;
function strictMatch(text) {
  if (!STRICT_RES) {
    STRICT_RES = ARTIST_NAMES.filter((n) => SHORT_OR_WORDY.has(norm(n).toLowerCase())).map((n) => {
      const w = norm(n);
      return new RegExp(`(?<![\\p{L}\\p{N}])(?:${escapeRe(w[0].toUpperCase() + w.slice(1))}|${escapeRe(w.toUpperCase())})(?![\\p{L}\\p{N}])`, 'u');
    });
  }
  return STRICT_RES.some((re) => re.test(text));
}

export function namesArtist(text) {
  const t = norm(text);
  return artistRe().loose.test(t) || strictMatch(t);
}

export function namesSongTitle(text) {
  return titleRe().test(norm(text));
}

// The words after a pointer phrase, up to punctuation or a joining word.
function phraseAfter(text, index) {
  return text.slice(index).split(/[,.;:!?\n()]|\s(?:with|and|but|for|in|at|over|under|featuring)\s/i)[0].trim();
}

// True when every word of `phrase` is descriptive (a genre, mood,
// instrument, era, tempo) or a number.
function isDescriptive(phrase) {
  const words = phrase.toLowerCase().replace(/['"“”]/g, '').split(/[\s/-]+/).filter(Boolean);
  if (!words.length) return true;
  return words.every((w) => DESCRIPTIVE.has(w) || /^\d+(?:s|bpm)?$/.test(w));
}

// "in the style of X", "sounds like X", "by X", "like X", "inspired by X":
// X is a person or a band when it is a proper name: a run of capitalised
// words that are not genre words, standing alone ("by Kendrick Lamar",
// "inspired by Hans Zimmer") rather than describing something ("Tokyo
// nights", "Rain On Glass" after a capital Like). Lowercase names are caught
// by the name list. "voice of" / "vocals of" also refuses anything that is
// not generic ("the voice of my neighbour"), allowing "the voice of an
// angel".
const POINTERS = [
  { re: /\b(?:voice|vocals?|singing|timbre|delivery)\s+(?:of|like)\s+/gi, kind: 'voice' },
  { re: /\b(?:in|with)\s+(?:the\s+)?(?:style|manner|vein|spirit|sound|mold|mould)\s+of\s+/gi, kind: 'name' },
  { re: /\bstyle\s+(?:of|like)\s+/gi, kind: 'name' },
  { re: /\b(?:sounds?|sounding|sung|sing|singing|rap|rapping|performed)\s+(?:just\s+|exactly\s+)?like\s+/gi, kind: 'name' },
  { re: /\b(?:a\s+la|à\s+la|reminiscent\s+of|inspired\s+by|influenced\s+by|channel(?:l)?ing|imitat(?:e|ing|ion\s+of)|mimic(?:king)?|emulat(?:e|ing)|copy(?:ing)?|soundalike\s+of|soundalike)\s+/gi, kind: 'name' },
  { re: /\b(?:by|from|feat\.?|ft\.?|featuring)\s+(?=[A-Z0-9])/g, kind: 'name' },
  { re: /\blike\s+(?=[A-Z])/g, kind: 'name' }
];

const ARTICLE_RE = /^(?:a|an|some|any)\s/i;

function properName(phrase) {
  const words = phrase.split(/\s+/).filter(Boolean);
  let run = 0;
  while (run < words.length && /^(?:[A-Z0-9][\p{L}\p{N}'.&$!-]*|&|and|the|of)$/u.test(words[run]) && (/^(?:the|of|and|&)$/i.test(words[run]) || !DESCRIPTIVE.has(words[run].toLowerCase().replace(/[^a-z0-9&'-]/g, '')))) run++;
  // Trailing joining words are not part of the name.
  while (run > 0 && /^(?:&|and|the|of)$/i.test(words[run - 1])) run--;
  if (!run) return false;
  return run === words.length || run >= 2;
}

function pointsAtPerson(text) {
  for (const { re, kind } of POINTERS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const phrase = phraseAfter(text, m.index + m[0].length);
      if (!phrase) continue;
      if (kind === 'voice' && !ARTICLE_RE.test(phrase) && !isDescriptive(phrase)) return true;
      if (properName(phrase.replace(/^the\s+/i, (t) => t))) return true;
    }
  }
  return false;
}

const CLONE_RE = /\b(?:clon(?:e|es|ed|ing)|deep\s?fake|voice\s*(?:print|model|swap|conversion|transfer)|(?:my|his|her|their|our|your|this|that|the\s+attached|a\s+real)\s+(?:own\s+)?(?:voice|singing\s+voice)|train(?:ed|ing)?\s+(?:it\s+|a\s+model\s+|the\s+model\s+)?on\s+(?:my|his|her|their|the)\s+(?:voice|vocals?|recordings?)|(?:use|using|with)\s+(?:the\s+)?(?:voice|vocals?)\s+(?:of|from)|sound\s+exactly\s+like|replicate\s+(?:the\s+)?(?:voice|vocals?))\b/i;

const COVER_RE = /\b(?:cover(?:\s+version)?\s+of|covering|remix(?:\s+of)?|re-?make\s+of|re-?record(?:ing)?\s+of|rendition\s+of|version\s+of\s+(?:the\s+)?(?:song|track|hit|tune)|(?:the\s+)?(?:song|track|tune|hit|single)\s+(?:called|titled|named)|sample\s+(?:of|from)|interpolat(?:e|ion)|parody\s+of)\b/i;
const QUOTED_TITLE_RE = /["“][^"”]{2,80}["”]/;

const LYRIC_SOURCE_RE = /\b(?:lyrics?|words|verse|chorus|hook|refrain)\s+(?:from|of|to|in)\s+(?:the\s+)?(?:song|track|hit|single|["“]|[A-Z])|\b(?:sing|singing|use|using|with)\s+(?:the\s+)?(?:real|original|actual|official|copyrighted)\s+lyrics|\bcopyrighted\s+lyrics\b|\blyrics?\s+by\s+[A-Z]/;
// A pasted lyric block in the prompt: several short lines, or a "lyrics:"
// / [Verse] / [Chorus] label, outside --lyrics.
const LYRIC_LABEL_RE = /(?:^|\n)\s*(?:lyrics?\s*:|\[(?:verse|chorus|bridge|hook|intro|outro|pre-chorus)[^\]]*\])/i;

function looksLikePastedLyrics(text) {
  if (LYRIC_LABEL_RE.test(text)) return true;
  const lines = String(text).split(/\n/).map((l) => l.trim()).filter(Boolean);
  const short = lines.filter((l) => l.length <= 70 && l.split(/\s+/).length >= 3);
  return lines.length >= 4 && short.length >= 4;
}

// Shingle fingerprints of lyrics the operator has listed as off limits
// (PG1_MUSIC_LYRIC_FINGERPRINTS: comma-separated sha256 hex of normalised
// 6-word runs, made with lyricFingerprints). No lyrics are kept in the code.
export const SHINGLE_WORDS = 6;
export function lyricWords(text) {
  return norm(text).toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/'/g, '').split(/\s+/).filter(Boolean);
}
export function lyricFingerprints(text) {
  const w = lyricWords(text);
  const out = new Set();
  for (let i = 0; i + SHINGLE_WORDS <= w.length; i++) out.add(crypto.createHash('sha256').update(w.slice(i, i + SHINGLE_WORDS).join(' ')).digest('hex'));
  return out;
}
function blockedFingerprints(env = {}) {
  return new Set(String(env.PG1_MUSIC_LYRIC_FINGERPRINTS || '').split(/[\s,]+/).filter((h) => /^[0-9a-f]{64}$/i.test(h)).map((h) => h.toLowerCase()));
}

const VOICE_WORDS_RE = /\b(?:voice|vocals?|sing|sings|sang|sung|singing|singer|rap|raps|rapping|style)\b/i;

export const REFUSAL_ALTERNATIVE = 'Describe it instead by genre, mood, instruments and era (for example: "warm 70s soul, Rhodes piano, brushed drums, falsetto hook, 92 BPM").';

export const SAFETY_REFUSALS = Object.freeze({
  artist: `PG1 Sound makes original music only, so it does not name or imitate real artists or bands. ${REFUSAL_ALTERNATIVE}`,
  voice_of: `PG1 Sound does not imitate a real person's voice or style. ${REFUSAL_ALTERNATIVE}`,
  song_title: `PG1 Sound does not recreate, cover or remix existing songs. ${REFUSAL_ALTERNATIVE}`,
  lyrics: 'PG1 Sound only sings lyrics you wrote yourself (put them after --lyrics) or lyrics PG1 writes; it does not use lyrics from existing songs. Leave --lyrics out and PG1 will write original ones, or describe the theme you want them to cover.',
  pasted_lyrics: 'To use your own lyrics, put them after --lyrics "…" (only lyrics you wrote are allowed); lyrics from existing songs are not used. Or leave them out and PG1 writes original ones.',
  voice_clone: `PG1 Sound does not clone or imitate anyone's voice, yours included. Pick a vocal description instead (for example: "breathy female alto", "gravelly baritone", "bright boy-band harmonies"). ${REFUSAL_ALTERNATIVE}`
});

// Resolves { ok: true } or { ok: false, reason, message }. `prompt` is the
// operator's description (flags removed); `lyrics` is the --lyrics text.
export function checkMusicRequest({ prompt = '', lyrics = '', env = {} } = {}) {
  const p = norm(prompt);
  const all = `${p}\n${norm(lyrics)}`;
  const refuse = (reason) => ({ ok: false, reason, message: SAFETY_REFUSALS[reason] });
  if (CLONE_RE.test(all)) return refuse('voice_clone');
  if (LYRIC_SOURCE_RE.test(all)) return refuse('lyrics');
  if (namesArtist(p)) return refuse(VOICE_WORDS_RE.test(p) ? 'voice_of' : 'artist');
  if (namesSongTitle(p) || COVER_RE.test(p)) return refuse('song_title');
  if (pointsAtPerson(p)) return refuse(VOICE_WORDS_RE.test(p) ? 'voice_of' : 'artist');
  // A quoted title next to song words ("make "Golden Hour" again").
  if (QUOTED_TITLE_RE.test(p) && /\b(?:song|track|tune|hit|single|again|cover|version|remake)\b/i.test(p)) return refuse('song_title');
  if (looksLikePastedLyrics(p)) return refuse('pasted_lyrics');
  if (lyrics) {
    if (namesArtist(lyrics) || namesSongTitle(lyrics)) return refuse('lyrics');
    const blocked = blockedFingerprints(env);
    if (blocked.size) for (const fp of lyricFingerprints(lyrics)) if (blocked.has(fp)) return refuse('lyrics');
  }
  return { ok: true };
}
