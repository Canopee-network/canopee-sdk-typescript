import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  NODE_COMMAND,
  NODE_RESPONSE,
  STRUCTS,
  ENUMS,
  WireValue,
  WireKind,
  encodeValue,
  decodeValue,
  encodeEnumVariants,
  decodeEnumVariants,
  Reader,
  Writer,
} from '../src/codec';

interface Vector {
  name: string;
  hex: string;
  value: WireValue;
}

const vectors = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', '..', 'tests', 'fixtures', 'golden.json'), 'utf8')
).vectors as Vector[];

test('golden fixture covers all commands, responses and types', () => {
  const names = vectors.map((v) => v.name);
  const cmdNames = NODE_COMMAND.map((v) => `cmd_${v.name}`);
  const resNames = NODE_RESPONSE.map((v) => `res_${v.name}`);
  const typeNames = [...Object.keys(STRUCTS), ...Object.keys(ENUMS)];
  for (const c of cmdNames) assert.ok(names.includes(c), `missing command vector ${c}`);
  for (const r of resNames) assert.ok(names.includes(r), `missing response vector ${r}`);
  for (const t of typeNames) assert.ok(names.includes(t), `missing type vector ${t}`);
  assert.ok(names.length >= cmdNames.length + resNames.length + typeNames.length);
});

test('every golden vector encodes to its pinned hex', () => {
  for (const v of vectors) {
    const payload = encode(v.name, v.value);
    assert.equal(payload.toString('hex'), v.hex, `encode mismatch for ${v.name}`);
  }
});

test('every golden hex decodes back to its value', () => {
  for (const v of vectors) {
    const decoded = decode(v.name, Buffer.from(v.hex, 'hex'));
    assert.deepEqual(decoded, v.value, `decode mismatch for ${v.name}`);
  }
});

/** Newtype aliases dumped as their own golden vectors. */
const SCALARS: Record<string, WireKind> = {
  ObjectId: { t: 'string' },
  CapabilityId: { t: 'string' },
};

function encode(name: string, value: WireValue): Buffer {
  if (name.startsWith('cmd_')) return encodeEnumVariants(NODE_COMMAND, value);
  if (name.startsWith('res_')) return encodeEnumVariants(NODE_RESPONSE, value);
  const w = new Writer();
  encodeValue(w, scalarOrStruct(name), value, name);
  return w.toBuffer();
}

function scalarOrStruct(name: string): WireKind {
  if (SCALARS[name]) return SCALARS[name]!;
  if (ENUMS[name]) return { t: 'enum', name };
  return { t: 'struct', name };
}

function decode(name: string, buf: Buffer): WireValue {
  if (name.startsWith('cmd_')) return decodeEnumVariants(NODE_COMMAND, buf);
  if (name.startsWith('res_')) return decodeEnumVariants(NODE_RESPONSE, buf);
  const r = new Reader(buf);
  const value = decodeValue(r, scalarOrStruct(name), name);
  if (!r.done) throw new Error(`${name}: trailing bytes`);
  return value;
}