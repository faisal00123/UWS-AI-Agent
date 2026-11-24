/**
 * Phase 1: verify `osm-pbf-parser` (dev-only dependency) against a small
 * locally-generated PBF fixture — no downloads, no network. This pins the
 * parser contract the offline extractor depends on: OSMHeader handling,
 * dense-node delta decoding, per-node tag terminators, and way ref deltas.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream, promises as fs } from 'node:fs';
import zlib from 'node:zlib';
import parseOSM from 'osm-pbf-parser';
import {
  buildFixturePbf,
  FIXTURE_NODES,
  FIXTURE_RELATIONS,
  FIXTURE_WAYS,
  type FixtureNode,
  type FixtureRelation,
  type FixtureWay,
} from '../helpers/pbf-fixture.ts';

interface ParsedNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}
interface ParsedWay {
  type: 'way';
  id: number;
  tags: Record<string, string>;
  refs: number[];
}
interface ParsedRelation {
  type: 'relation';
  id: number;
  tags: Record<string, string>;
  members: Array<{ type: string; id: number; role: string }>;
}
type ParsedItem = ParsedNode | ParsedWay | ParsedRelation;

function parseFixture(file: string): Promise<ParsedItem[]> {
  return new Promise((resolve, reject) => {
    const items: ParsedItem[] = [];
    const source = createReadStream(file);
    const parser = parseOSM();
    source.on('error', reject);
    parser.on('error', reject);
    parser.on('data', (batch: ParsedItem[]) => items.push(...batch));
    parser.on('end', () => resolve(items));
    source.pipe(parser);
  });
}

test('fixture round-trip: dense nodes, way refs and relations decode intact', async (t) => {
  const fixture = await buildFixturePbf();
  t.after(() => fs.rm(fixture.dir, { recursive: true, force: true }));

  const items = await parseFixture(fixture.file);

  const nodes = items.filter((i): i is ParsedNode => i.type === 'node');
  const ways = items.filter((i): i is ParsedWay => i.type === 'way');
  const relations = items.filter((i): i is ParsedRelation => i.type === 'relation');

  assert.equal(nodes.length, FIXTURE_NODES.length, 'every dense node decodes');
  assert.equal(ways.length, FIXTURE_WAYS.length, 'every way decodes');
  assert.equal(relations.length, FIXTURE_RELATIONS.length, 'relations decode too');

  // Coordinates survive the 1e-7 granularity round trip (±1e-6 degrees).
  for (const expected of FIXTURE_NODES) {
    const actual = nodes.find((n) => n.id === expected.id);
    assert.ok(actual, `node ${expected.id} present`);
    assert.ok(
      Math.abs(actual.lat - expected.lat) < 1e-6,
      `node ${expected.id} lat ${actual.lat} ≈ ${expected.lat}`,
    );
    assert.ok(
      Math.abs(actual.lon - expected.lon) < 1e-6,
      `node ${expected.id} lon ${actual.lon} ≈ ${expected.lon}`,
    );
    assert.deepEqual(actual.tags, expected.tags, `node ${expected.id} tags intact`);
  }

  // Way refs decode from deltas back to absolute node ids.
  for (const expected of FIXTURE_WAYS) {
    const actual = ways.find((w) => w.id === expected.id);
    assert.ok(actual, `way ${expected.id} present`);
    assert.deepEqual(actual.refs, expected.refs, `way ${expected.id} refs intact`);
    assert.deepEqual(actual.tags, expected.tags, `way ${expected.id} tags intact`);
  }

  // Relations keep their tag set (members are geometry-only in the fixture).
  const rel = relations.find((r) => r.id === FIXTURE_RELATIONS[0]?.id);
  assert.ok(rel, 'relation present');
  assert.deepEqual(rel.tags, FIXTURE_RELATIONS[0]?.tags, 'relation tags intact');
});

test('fixture file is a real zlib PBF (OSMHeader first, OSMData after)', async (t) => {
  const fixture = await buildFixturePbf();
  t.after(() => fs.rm(fixture.dir, { recursive: true, force: true }));

  const buf = await fs.readFile(fixture.file);
  assert.ok(buf.length > 64, 'fixture has content');

  // Minimal protobuf varint reader (only what BlobHeader/Blob need).
  const readVarint = (offset: { o: number }): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const byte = buf[offset.o++];
      assert.ok(byte !== undefined, 'varint inside bounds');
      v += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return v;
      shift += 7;
    }
  };
  const parseBlobHeader = (at: number): { type: string; datasize: number; end: number } => {
    const headerLen = buf.readUInt32BE(at);
    const state = { o: at + 4 };
    const end = state.o + headerLen;
    let type = '';
    let datasize = 0;
    while (state.o < end) {
      const tag = readVarint(state);
      const field = tag >> 3;
      const wire = tag & 7;
      if (field === 1 && wire === 2) {
        const len = readVarint(state);
        type = buf.toString('utf8', state.o, state.o + len);
        state.o += len;
      } else if (field === 3 && wire === 0) {
        datasize = readVarint(state);
      } else if (wire === 0) {
        readVarint(state);
      } else if (wire === 2) {
        state.o += readVarint(state);
      } else {
        assert.fail(`unexpected wire type ${wire} in BlobHeader`);
      }
    }
    return { type, datasize, end };
  };

  // Block 1 must be the OSMHeader.
  const h1 = parseBlobHeader(0);
  assert.equal(h1.type, 'OSMHeader', 'first block is OSMHeader');

  // Block 2 (offset = 4 + header1 + blob1) must be OSMData with a zlib blob.
  const h2 = parseBlobHeader(h1.end + h1.datasize);
  assert.equal(h2.type, 'OSMData', 'second block is OSMData');

  // Walk the Blob fields; field 3 = zlib_data (the only format the parser accepts).
  const state = { o: h2.end };
  const blobEnd = h2.end + h2.datasize;
  let inflated: Buffer | null = null;
  while (state.o < blobEnd) {
    const tag = readVarint(state);
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) {
      readVarint(state);
    } else if (wire === 2) {
      const len = readVarint(state);
      if (field === 3) inflated = zlib.inflateSync(buf.subarray(state.o, state.o + len));
      state.o += len;
    } else {
      assert.fail(`unexpected wire type ${wire} in Blob`);
    }
  }
  assert.ok(inflated, 'OSMData blob carries zlib_data (not raw/lzma)');
  assert.ok(inflated.length > 0, 'zlib payload inflates');
});

test('fixture nodes are unique by id (dedupe tests rely on it)', () => {
  const ids = FIXTURE_NODES.map((n: FixtureNode) => n.id);
  assert.equal(new Set(ids).size, ids.length);
  const wayIds = FIXTURE_WAYS.map((w: FixtureWay) => w.id);
  assert.equal(new Set(wayIds).size, wayIds.length);
  const relIds = FIXTURE_RELATIONS.map((r: FixtureRelation) => r.id);
  assert.equal(new Set(relIds).size, relIds.length);
});
