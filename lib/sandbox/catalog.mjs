// PG1 SANDBOX CATALOGUE: the kinds of thing a world can hold, the way the
// engine moves them and the way the viewer draws them. Any kind name is
// still allowed (a world is data); a kind listed here also gets a class, a
// domain (where it can go), a top speed and seats, which the `travel` rule
// and riders (an entity whose `inside` property names another) use.
//
//   class   person | animal | plant | building | structure | vehicle | celestial | thing
//   domain  ground (stays on the ground) | water (on the water) | air (flies,
//           below the space altitude) | space (anywhere, into space) | fixed (never moves)
//   speed   metres a step at most (the travel rule's default)
//   seats   how many riders it carries (0: none)
//   footprint  metres from its centre where a traveller heading to it
//           stops (at a house's door, not inside it)
//
// Speeds are per step, not per second: a step is whatever a world says it
// is. With the default day of 240 steps, the numbers below are plausible
// for steps of about six seconds.

const k = (cls, domain, speed, seats, words, extra = {}) => Object.freeze({ class: cls, domain, speed, seats, words, footprint: 0, ...extra });

export const CATALOG = Object.freeze({
  // People and animals
  person: k('person', 'ground', 8, 0, 'a person'),
  child: k('person', 'ground', 6, 0, 'a child'),
  astronaut: k('person', 'ground', 6, 0, 'a person in a white suit'),
  dog: k('animal', 'ground', 12, 0, 'a dog'),
  cat: k('animal', 'ground', 9, 0, 'a cat'),
  rabbit: k('animal', 'ground', 10, 0, 'a rabbit'),
  fox: k('animal', 'ground', 12, 0, 'a fox'),
  deer: k('animal', 'ground', 14, 0, 'a deer'),
  horse: k('animal', 'ground', 20, 1, 'a horse'),
  cow: k('animal', 'ground', 4, 0, 'a cow'),
  bird: k('animal', 'air', 30, 0, 'a bird'),
  fish: k('animal', 'water', 6, 0, 'a fish'),
  // Plants
  grass: k('plant', 'fixed', 0, 0, 'a patch of grass'),
  flower: k('plant', 'fixed', 0, 0, 'a flower'),
  bush: k('plant', 'fixed', 0, 0, 'a bush'),
  tree: k('plant', 'fixed', 0, 0, 'a tree', { footprint: 4 }),
  pine: k('plant', 'fixed', 0, 0, 'a pine tree'),
  palm: k('plant', 'fixed', 0, 0, 'a palm tree'),
  crop: k('plant', 'fixed', 0, 0, 'a row of crops', { footprint: 6 }),
  // Buildings
  house: k('building', 'fixed', 0, 6, 'a house', { footprint: 12 }),
  cabin: k('building', 'fixed', 0, 4, 'a wooden cabin', { footprint: 10 }),
  apartment: k('building', 'fixed', 0, 40, 'an apartment block', { footprint: 18 }),
  tower: k('building', 'fixed', 0, 200, 'a tall glass tower', { footprint: 22 }),
  shop: k('building', 'fixed', 0, 20, 'a shop', { footprint: 14 }),
  cafe: k('building', 'fixed', 0, 20, 'a café', { footprint: 14 }),
  school: k('building', 'fixed', 0, 100, 'a school', { footprint: 30 }),
  hospital: k('building', 'fixed', 0, 100, 'a hospital', { footprint: 26 }),
  factory: k('building', 'fixed', 0, 50, 'a factory', { footprint: 28 }),
  barn: k('building', 'fixed', 0, 10, 'a barn', { footprint: 14 }),
  hangar: k('building', 'fixed', 0, 10, 'an aircraft hangar', { footprint: 24 }),
  station: k('building', 'fixed', 0, 50, 'a station', { footprint: 32 }),
  police_station: k('building', 'fixed', 0, 30, 'a police station', { footprint: 16 }),
  prison: k('building', 'fixed', 0, 60, 'a prison behind a high wall', { footprint: 30 }),
  colony: k('structure', 'space', 0, 200, 'domes and towers of a settlement', { inSpace: true }),
  hotel: k('building', 'fixed', 0, 120, 'a hotel', { footprint: 20 }),
  terminal: k('building', 'fixed', 0, 400, 'an airport terminal with a control tower', { footprint: 22 }),
  barracks: k('building', 'fixed', 0, 200, 'army barracks behind a fence', { footprint: 30 }),
  cinema: k('building', 'fixed', 0, 200, 'a cinema', { footprint: 16 }),
  theatre: k('building', 'fixed', 0, 300, 'a theatre with columns', { footprint: 18 }),
  bar: k('building', 'fixed', 0, 40, 'a bar', { footprint: 10 }),
  stadium: k('building', 'fixed', 0, 5000, 'a stadium', { footprint: 60 }),
  // Structures
  road: k('structure', 'fixed', 0, 0, 'a road'),
  bridge: k('structure', 'fixed', 0, 0, 'a bridge'),
  runway: k('structure', 'fixed', 0, 0, 'a runway'),
  launch_pad: k('structure', 'fixed', 0, 0, 'a launch pad'),
  lake: k('structure', 'fixed', 0, 0, 'a lake', { footprint: 0 }),
  rock: k('structure', 'fixed', 0, 0, 'a rock'),
  crater: k('structure', 'fixed', 0, 0, 'a crater where a meteorite struck'),
  fence: k('structure', 'fixed', 0, 0, 'a fence'),
  lamp: k('structure', 'fixed', 0, 0, 'a street lamp'),
  fountain: k('structure', 'fixed', 0, 0, 'a fountain', { footprint: 10 }),
  island: k('structure', 'fixed', 0, 0, 'a land with its own people', { footprint: 0 }),
  port: k('structure', 'fixed', 0, 0, 'a harbour with a long pier', { footprint: 12 }),
  beach: k('structure', 'fixed', 0, 0, 'a sandy beach with umbrellas', { footprint: 15 }),
  amusement: k('structure', 'fixed', 0, 0, 'a fair with a big wheel', { footprint: 25 }),
  monument: k('structure', 'fixed', 0, 0, 'a tall carved stone', { footprint: 6 }),
  // Vehicles
  bike: k('vehicle', 'ground', 30, 1, 'a bicycle'),
  motorbike: k('vehicle', 'ground', 80, 2, 'a motorbike'),
  car: k('vehicle', 'ground', 90, 4, 'a car'),
  taxi: k('vehicle', 'ground', 90, 4, 'a yellow taxi'),
  police_car: k('vehicle', 'ground', 110, 4, 'a police car'),
  bus: k('vehicle', 'ground', 70, 40, 'a bus'),
  truck: k('vehicle', 'ground', 70, 2, 'a truck'),
  tractor: k('vehicle', 'ground', 25, 1, 'a tractor'),
  train: k('vehicle', 'ground', 150, 200, 'a train'),
  boat: k('vehicle', 'water', 40, 6, 'a boat'),
  ship: k('vehicle', 'water', 50, 500, 'a ship'),
  ferry: k('vehicle', 'water', 70, 300, 'a ferry'),
  patrol_boat: k('vehicle', 'water', 90, 8, 'a grey patrol boat'),
  army_truck: k('vehicle', 'ground', 70, 12, 'an army truck'),
  plane: k('vehicle', 'air', 600, 150, 'a passenger plane'),
  small_plane: k('vehicle', 'air', 300, 4, 'a small propeller plane'),
  jet: k('vehicle', 'air', 1200, 2, 'a fast jet'),
  helicopter: k('vehicle', 'air', 250, 6, 'a helicopter'),
  drone: k('vehicle', 'air', 90, 0, 'a small drone'),
  hot_air_balloon: k('vehicle', 'air', 30, 4, 'a hot-air balloon'),
  rocket: k('vehicle', 'space', 3000, 6, 'a tall rocket'),
  shuttle: k('vehicle', 'space', 2500, 8, 'a winged spacecraft'),
  // Space
  space_station: k('structure', 'space', 0, 12, 'a station turning in orbit', { inSpace: true }),
  satellite: k('vehicle', 'space', 0, 0, 'a satellite', { inSpace: true }),
  star: k('celestial', 'fixed', 0, 0, 'a bright star', { inSpace: true }),
  planet: k('celestial', 'space', 0, 0, 'a planet', { inSpace: true }),
  moon: k('celestial', 'space', 0, 0, 'a moon', { inSpace: true }),
  asteroid: k('celestial', 'space', 0, 0, 'a tumbling rock in space', { inSpace: true }),
  // Others out there
  alien_world: k('celestial', 'space', 0, 0, 'a far planet glowing with city lights', { inSpace: true }),
  alien_ship: k('vehicle', 'space', 4000, 20, 'a smooth, silent craft unlike anything built here', { inSpace: true }),
  alien: k('person', 'ground', 7, 0, 'a tall, slender visitor')
});

export const CATALOG_KINDS = Object.freeze(Object.keys(CATALOG));
export const CLASSES = Object.freeze(['person', 'animal', 'plant', 'building', 'structure', 'vehicle', 'celestial', 'thing']);
export const DOMAINS = Object.freeze(['ground', 'water', 'air', 'space', 'fixed']);

// Default altitude where space begins, and an airliner's cruising height, in
// metres: believable for worlds a few kilometres across, and well below space
// (small planes cruise lower and jets higher: lib/sandbox/movement.mjs FLIGHT).
export const DEFAULT_SPACE_ALTITUDE = 2000;
export const CRUISE_ALTITUDE = 600;

const UNKNOWN = Object.freeze({ class: 'thing', domain: 'ground', speed: 5, seats: 0, words: null });

// The catalogue entry for a kind. A kind that is not listed is a "thing"
// that walks on the ground at 5 m a step; a listed kind's name may carry a
// suffix after "_" or "-" ("car_red", "house-2" are cars and houses).
const SEEN = new Map(); // kind -> entry (a kind's entry never changes)
export function catalogFor(kind) {
  const k0 = String(kind || '');
  if (CATALOG[k0]) return CATALOG[k0];
  const hit = SEEN.get(k0);
  if (hit) return hit;
  const base = k0.replace(/[_-][a-z0-9]+$/, '');
  const out = base !== k0 && CATALOG[base] ? CATALOG[base] : UNKNOWN;
  if (SEEN.size > 5000) SEEN.clear();
  SEEN.set(k0, out);
  return out;
}

export const isVehicle = (kind) => catalogFor(kind).class === 'vehicle';

// The catalogue as agents see it (get_catalog): kind, class, domain, speed, seats.
export function catalogView() {
  return CATALOG_KINDS.map((kind) => {
    const c = CATALOG[kind];
    return { kind, class: c.class, domain: c.domain, speed_m_per_step: c.speed, seats: c.seats, description: c.words };
  });
}
