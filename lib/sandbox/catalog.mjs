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
  // Structures
  road: k('structure', 'fixed', 0, 0, 'a road'),
  bridge: k('structure', 'fixed', 0, 0, 'a bridge'),
  runway: k('structure', 'fixed', 0, 0, 'a runway'),
  launch_pad: k('structure', 'fixed', 0, 0, 'a launch pad'),
  lake: k('structure', 'fixed', 0, 0, 'a lake', { footprint: 0 }),
  rock: k('structure', 'fixed', 0, 0, 'a rock'),
  fence: k('structure', 'fixed', 0, 0, 'a fence'),
  lamp: k('structure', 'fixed', 0, 0, 'a street lamp'),
  fountain: k('structure', 'fixed', 0, 0, 'a fountain', { footprint: 10 }),
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
  asteroid: k('celestial', 'space', 0, 0, 'a tumbling rock in space', { inSpace: true })
});

export const CATALOG_KINDS = Object.freeze(Object.keys(CATALOG));
export const CLASSES = Object.freeze(['person', 'animal', 'plant', 'building', 'structure', 'vehicle', 'celestial', 'thing']);
export const DOMAINS = Object.freeze(['ground', 'water', 'air', 'space', 'fixed']);

// Default altitude where space begins, and a plane's cruising height, in metres.
export const DEFAULT_SPACE_ALTITUDE = 2000;
export const CRUISE_ALTITUDE = 300;

const UNKNOWN = Object.freeze({ class: 'thing', domain: 'ground', speed: 5, seats: 0, words: null });

// The catalogue entry for a kind. A kind that is not listed is a "thing"
// that walks on the ground at 5 m a step; a listed kind's name may carry a
// suffix after "_" or "-" ("car_red", "house-2" are cars and houses).
export function catalogFor(kind) {
  const k0 = String(kind || '');
  if (CATALOG[k0]) return CATALOG[k0];
  const base = k0.replace(/[_-][a-z0-9]+$/, '');
  if (base !== k0 && CATALOG[base]) return CATALOG[base];
  return UNKNOWN;
}

export const isVehicle = (kind) => catalogFor(kind).class === 'vehicle';

// The catalogue as agents see it (get_catalog): kind, class, domain, speed, seats.
export function catalogView() {
  return CATALOG_KINDS.map((kind) => {
    const c = CATALOG[kind];
    return { kind, class: c.class, domain: c.domain, speed_m_per_step: c.speed, seats: c.seats, description: c.words };
  });
}
