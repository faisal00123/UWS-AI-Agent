/**
 * Synthetic PBF fixture builder (dev/test only — never shipped).
 *
 * Encodes a tiny, Pakistan-flavored .osm.pbf entirely in memory using the
 * SAME `osm-pbf-parser` protobuf schemas the real parser decodes with, so the
 * round trip is byte-format-accurate without downloading any real extract.
 * Contents mirror what the extractor must handle: dense nodes with/without
 * tags, ways needing a second pass for coordinates, a relation, a duplicate
 * place, an entity with no resolvable city, and a way with a missing ref.
 *
 * The PBF layout follows the OSM spec: OSMHeader block first (the parser
 * requires it), then one OSMData PrimitiveBlock with a shared string table
 * and three primitive groups (dense nodes / ways / relations). All blobs are
 * zlib-compressed — the only compression `osm-pbf-parser` supports, and the
 * format Geofabrik ships (verified against real pakistan-latest.osm.pbf).
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import parsers from 'osm-pbf-parser/lib/parsers.js';

export interface FixtureNode {
  id: number;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

export interface FixtureWay {
  id: number;
  refs: number[];
  tags: Record<string, string>;
}

export interface FixtureRelation {
  id: number;
  tags: Record<string, string>;
}

/**
 * Dense nodes, ascending id. Includes way-geometry nodes (untagged ids
 * 3001–3008) that only exist so ways can be centred in pass B.
 */
export const FIXTURE_NODES: FixtureNode[] = [
  // Karachi clinic with full contact evidence — addr:city wins city resolution.
  {
    id: 1001,
    lat: 24.8607,
    lon: 67.0104,
    tags: {
      amenity: 'clinic',
      name: 'Fixture Health Clinic',
      phone: '+92 21 111 000 111',
      website: 'https://clinic.example',
      email: 'desk@clinic.example',
      'addr:city': 'Karachi',
      'addr:street': 'Shahrah-e-Faisal',
      'addr:housenumber': '12',
    },
  },
  // Islamabad school with no addr:city → bbox fallback (lat ≥ 33.655).
  { id: 1002, lat: 33.6844, lon: 73.0551, tags: { amenity: 'school', name: 'Fixture Grammar School' } },
  // Lahore supermarket → retail, city via bbox.
  {
    id: 1003,
    lat: 31.4504,
    lon: 74.2813,
    tags: { shop: 'supermarket', name: 'Fixture Mart', 'contact:phone': '+92 42 111 222 333' },
  },
  // Rawalpindi fast food with addr:city (adjacent to Islamabad — tag wins).
  {
    id: 1004,
    lat: 33.6007,
    lon: 73.038,
    tags: { amenity: 'fast_food', name: 'Fixture Burger Corner', 'addr:city': 'Rawalpindi' },
  },
  // Named but no category tags → skipped (category).
  { id: 1005, lat: 24.9, lon: 67.0, tags: { name: 'Fixture Park Bench', leisure: 'bench' } },
  // Category but no name → skipped (name).
  { id: 1006, lat: 31.5, lon: 74.3, tags: { shop: 'florist' } },
  // addr:city outside the default eight cities is kept as evidence.
  {
    id: 1007,
    lat: 32.4945,
    lon: 74.5229,
    tags: { amenity: 'clinic', name: 'Fixture Sialkot Clinic', 'addr:city': 'Sialkot' },
  },
  // No addr:city and outside every bbox → skipped (city).
  { id: 1008, lat: 30.0, lon: 70.0, tags: { amenity: 'school', name: 'Fixture Rural School' } },
  // Exact duplicate place of 1001 (same name/category/city/coords) → deduped.
  {
    id: 1009,
    lat: 24.8607,
    lon: 67.0104,
    tags: { amenity: 'clinic', name: 'Fixture Health Clinic', 'addr:city': 'Karachi' },
  },
  // Untagged → counted as untagged, never a candidate.
  { id: 1010, lat: 24.95, lon: 67.05, tags: {} },
  // Way geometry nodes (untagged): Lahore square for way 2001.
  { id: 3001, lat: 31.52, lon: 74.358, tags: {} },
  { id: 3002, lat: 31.52, lon: 74.3594, tags: {} },
  { id: 3003, lat: 31.521, lon: 74.3594, tags: {} },
  { id: 3004, lat: 31.521, lon: 74.358, tags: {} },
  // Islamabad pair for way 2002.
  { id: 3005, lat: 33.7, lon: 73.1, tags: {} },
  { id: 3006, lat: 33.701, lon: 73.101, tags: {} },
  // Faisalabad pair for way 2003 (city must come from the bbox).
  { id: 3007, lat: 31.42, lon: 73.14, tags: {} },
  { id: 3008, lat: 31.421, lon: 73.141, tags: {} },
];

export const FIXTURE_WAYS: FixtureWay[] = [
  // Lahore restaurant outline with addr:city.
  {
    id: 2001,
    refs: [3001, 3002, 3003, 3004],
    tags: {
      amenity: 'restaurant',
      name: 'Fixture Lahore Diner',
      'addr:city': 'Lahore',
      website: 'https://diner.example',
    },
  },
  // Islamabad law office → professional_services (office=* but not estate_agent).
  {
    id: 2002,
    refs: [3005, 3006],
    tags: { office: 'lawyer', name: 'Fixture Legal Chambers', 'addr:city': 'Islamabad', phone: '+92 51 111 444 555' },
  },
  // Faisalabad estate agent → real_estate, city via bbox (no addr:city).
  { id: 2003, refs: [3007, 3008], tags: { office: 'estate_agent', name: 'Fixture Estates' } },
  // Missing node ref → no centroid → skipped (coords).
  {
    id: 2004,
    refs: [9999],
    tags: { amenity: 'clinic', name: 'Fixture Ghost Clinic', 'addr:city': 'Karachi' },
  },
];

export const FIXTURE_RELATIONS: FixtureRelation[] = [
  // Named relation with a category tag → deliberately skipped (relation).
  { id: 4001, tags: { amenity: 'clinic', name: 'Fixture Relation Clinic' } },
];

/** Interned string table; index 0 stays blank per the OSM spec. */
class StringTable {
  private strings: string[] = [''];
  sid(value: string): number {
    const i = this.strings.indexOf(value);
    if (i >= 0) return i;
    this.strings.push(value);
    return this.strings.length - 1;
  }
  toBuffers(): Buffer[] {
    return this.strings.map((s) => Buffer.from(s, 'utf8'));
  }
}

/** One PBF file block: 4-byte big-endian header length, BlobHeader, Blob. */
function frame(type: string, message: Buffer): Buffer {
  const zlibData = zlib.deflateSync(message);
  const blob = parsers.file.Blob.encode({ raw_size: message.length, zlib_data: zlibData });
  const header = parsers.file.BlobHeader.encode({ type, datasize: blob.length });
  const size = Buffer.alloc(4);
  size.writeUInt32BE(header.length, 0);
  return Buffer.concat([size, header, blob]);
}

function deltaRefs(refs: number[]): number[] {
  let prev = 0;
  return refs.map((r) => {
    const d = r - prev;
    prev = r;
    return d;
  });
}

/** Encode the fixture as a complete .osm.pbf byte stream. */
export function encodeFixturePbf(): Buffer {
  const st = new StringTable();
  const GRAN = 1e-7; // PrimitiveBlock granularity 100 → 1e-9 * 100 degrees

  const idDeltas: number[] = [];
  const latDeltas: number[] = [];
  const lonDeltas: number[] = [];
  const keysVals: number[] = [];
  let lastId = 0;
  let lastLat = 0;
  let lastLon = 0;
  for (const node of FIXTURE_NODES) {
    idDeltas.push(node.id - lastId);
    lastId = node.id;
    const latRaw = Math.round(node.lat / GRAN);
    const lonRaw = Math.round(node.lon / GRAN);
    latDeltas.push(latRaw - lastLat);
    lastLat = latRaw;
    lonDeltas.push(lonRaw - lastLon);
    lastLon = lonRaw;
    for (const [k, v] of Object.entries(node.tags)) {
      keysVals.push(st.sid(k), st.sid(v));
    }
    keysVals.push(0); // per-node tag terminator (parser requires it)
  }

  const ways = FIXTURE_WAYS.map((w) => ({
    id: w.id,
    keys: Object.keys(w.tags).map((k) => st.sid(k)),
    vals: Object.values(w.tags).map((v) => st.sid(v)),
    refs: deltaRefs(w.refs),
  }));

  const relations = FIXTURE_RELATIONS.map((r) => ({
    id: r.id,
    keys: Object.keys(r.tags).map((k) => st.sid(k)),
    vals: Object.values(r.tags).map((v) => st.sid(v)),
    roles_sid: [0],
    memids: [r.id],
    types: [0], // member type 0 = node
  }));

  const header = parsers.osm.HeaderBlock.encode({
    required_features: ['OsmSchema-V0.6', 'DenseNodes'],
    writingprogram: 'uws-test-fixture',
  });

  const block = parsers.osm.PrimitiveBlock.encode({
    stringtable: { s: st.toBuffers() },
    primitivegroup: [
      { dense: { id: idDeltas, lat: latDeltas, lon: lonDeltas, keys_vals: keysVals } },
      { ways },
      { relations },
    ],
    granularity: 100,
    lat_offset: 0,
    lon_offset: 0,
    date_granularity: 1000,
  });

  return Buffer.concat([frame('OSMHeader', header), frame('OSMData', block)]);
}

export interface FixturePbf {
  dir: string;
  file: string;
}

/** Write the fixture to a fresh temp directory (caller removes `dir`). */
export async function buildFixturePbf(): Promise<FixturePbf> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uws-osm-fixture-'));
  const file = path.join(dir, 'fixture.osm.pbf');
  await fs.writeFile(file, encodeFixturePbf());
  return { dir, file };
}
