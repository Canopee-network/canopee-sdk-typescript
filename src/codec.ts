/**
 * Binary codec for the Canopee wire protocol.
 *
 * The node (and the Rust SDK) serializes every `NodeCommand` / `NodeResponse`
 * with **bincode 1.x legacy config**:
 *
 *   - little-endian fixints (`u8/u16/u32/u64`, `bool` = one byte)
 *   - enum variants tagged with a `u32` discriminant, in declaration order
 *   - `String`/`Vec` prefixed with a `u64` byte length
 *   - `Option` tagged with a single `0`/`1` byte
 *   - fixed-size arrays (`[u8; 32]`) written raw with no prefix
 *   - struct fields serialized in declaration order
 *   - maps as `u64` entry count then sorted `(key, value)` pairs — bincode
 *     orders HashMap entries arbitrarily, so SDKs sort keys to produce
 *     stable, reproducible bytes (the node reads back any order).
 *
 * A frame on the Unix socket is `u32 LE <payload-byte-length>` followed by
 * the payload bytes produced by this codec.
 *
 * The golden fixture `tests/fixtures/golden.json` (generated from the Rust
 * `canopee-sdk` crate) pins every encoder/decoder here to the exact bytes
 * the real node speaks.
 */

// ---------------------------------------------------------------------------
// Wire type descriptors
// ---------------------------------------------------------------------------

export type WireKind =
  | { t: 'u32' }
  | { t: 'u64' }
  | { t: 'u8' }
  | { t: 'bool' }
  | { t: 'string' }
  | { t: 'bytes' } // Vec<u8> with a u64 length prefix
  | { t: 'bytesN'; n: number } // fixed-size byte array, no prefix
  | { t: 'struct'; name: string }
  | { t: 'enum'; name: string }
  | { t: 'vec'; of: WireKind }
  | { t: 'opt'; of: WireKind }
  | { t: 'map'; key: 'string'; val: WireKind }
  | { t: 'any' }; // opaque: round-trips the serde_json value (bytes passthrough)

export type WireField = [name: string, kind: WireKind];

/** One variant of a wire enum. `fields` is empty for unit variants. */
export interface WireEnumVariant {
  name: string;
  fields: WireField[];
}

export const k = {
  u32: { t: 'u32' } as WireKind,
  u64: { t: 'u64' } as WireKind,
  u8: { t: 'u8' } as WireKind,
  bool: { t: 'bool' } as WireKind,
  string: { t: 'string' } as WireKind,
  bytes: { t: 'bytes' } as WireKind,
  bytesN: (n: number): WireKind => ({ t: 'bytesN', n }),
  struct: (name: string): WireKind => ({ t: 'struct', name }),
  enm: (name: string): WireKind => ({ t: 'enum', name }),
  vec: (of: WireKind): WireKind => ({ t: 'vec', of }),
  opt: (of: WireKind): WireKind => ({ t: 'opt', of }),
  map: (val: WireKind): WireKind => ({ t: 'map', key: 'string', val }),
};

export const OBJECT_ID = k.string; // ObjectId/IdentityId/CapabilityId newtypes
export const DH_KEY = k.bytesN(32);

// ---------------------------------------------------------------------------
// Wire type catalog (structs + nested enums)
// ---------------------------------------------------------------------------

export function struct(name: string): [string, WireKind][] {
  const s = STRUCTS[name];
  if (!s) throw new Error(`unknown wire struct: ${name}`);
  return s;
}

export function enumDef(name: string): WireEnumVariant[] {
  const e = ENUMS[name];
  if (!e) throw new Error(`unknown wire enum: ${name}`);
  return e;
}

export const STRUCTS: Record<string, WireField[]> = {
  PubSubMessage: [
    ['topic', k.string],
    ['source', k.opt(k.string)],
    ['data', k.bytes],
  ],
  PeerInfo: [
    ['peer_id', k.string],
    ['identity', k.opt(k.string)],
    ['username', k.opt(k.string)],
    ['display_name', k.opt(k.string)],
    ['addresses', k.vec(k.string)],
  ],
  RelayReservationInfo: [
    ['relay_peer_id', k.string],
    ['renewal', k.bool],
    ['listen_addrs', k.vec(k.string)],
  ],
  DeviceInfo: [
    ['device_id', k.string],
    ['device_name', k.string],
  ],
  PairingQrData: [
    ['version', k.u8],
    ['device_id', k.string],
    ['device_name', k.string],
    ['lan_addr', k.string],
    ['code', k.string],
    ['session_id', k.string],
  ],
  PairingRecord: [
    ['name', k.string],
    ['object', k.struct('Object')],
    ['pointer', k.struct('AppPointerRecord')],
  ],
  PairingData: [
    ['version', k.u8],
    ['identity_key', k.bytes],
    ['records', k.vec(k.struct('PairingRecord'))],
  ],
  SyncResult: [
    ['profile_updated', k.bool],
    ['contacts_updated', k.bool],
    ['devices_updated', k.bool],
  ],
  AppManifest: [
    ['name', k.string],
    ['owner', k.string],
    ['entrypoint', k.string],
    ['assets', k.map(k.string)],
  ],
  ObjectMetadata: [
    ['created_at', k.u64],
    ['size', k.u64],
    ['content_type', k.opt(k.string)],
  ],
  ObjectPayload: [
    ['owner', k.string],
    ['metadata', k.struct('ObjectMetadata')],
    ['object_type', k.enm('ObjectType')],
    ['data', k.bytes],
  ],
  ObjectInfo: [
    ['id', k.string],
    ['owner', k.string],
    ['size', k.u64],
    ['verified', k.bool],
    ['name', k.opt(k.string)],
    ['object_type', k.enm('ObjectType')],
  ],
  Object: [
    ['id', k.string],
    ['payload', k.struct('ObjectPayload')],
    ['public_key', k.bytes],
    ['signature', k.bytes],
  ],
  ExportBundle: [
    ['version', k.u32],
    ['object', k.struct('Object')],
  ],
  Profile: [
    ['display_name', k.string],
    ['dh_public_key', DH_KEY],
    ['avatar', k.opt(k.string)],
    ['version', k.u64],
  ],
  Contact: [
    ['name', k.string],
    ['peer_id', k.string],
    ['dh_public_key', DH_KEY],
    ['note', k.opt(k.string)],
  ],
  ContactList: [
    ['contacts', k.vec(k.struct('Contact'))],
    ['version', k.u64],
  ],
  HomeEntry: [
    ['name', k.string],
    ['object', k.string],
    ['object_type', k.enm('ObjectType')],
    ['shared', k.bool],
    ['app', k.opt(k.string)],
  ],
  HomeIndex: [
    ['profile', k.opt(k.string)],
    ['contacts', k.opt(k.string)],
    ['entries', k.vec(k.struct('HomeEntry'))],
    ['version', k.u64],
  ],
  AppPointerRecord: [
    ['name', k.string],
    ['owner', k.string],
    ['manifest', k.string],
    ['published_at', k.u64],
    ['public_key', k.bytes],
    ['signature', k.bytes],
  ],
  Capability: [
    ['id', k.string],
    ['issuer', k.string],
    ['subject', k.string],
    ['resource', k.enm('Resource')],
    ['permissions', k.vec(k.enm('Permission'))],
    ['issued_at', k.u64],
    ['expires_at', k.opt(k.u64)],
    ['public_key', k.bytes],
    ['signature', k.bytes],
  ],
  ExportCapability: [
    ['version', k.u8],
    ['capability', k.struct('Capability')],
  ],
  CapabilityEntry: [
    ['capability', k.struct('Capability')],
    ['revoked', k.bool],
  ],
  CapabilityIndex: [
    ['entries', k.vec(k.struct('CapabilityEntry'))],
    ['version', k.u64],
  ],
};

export const ENUMS: Record<string, WireEnumVariant[]> = {
  ObjectType: [
    { name: 'Blob', fields: [] },
    { name: 'AppManifest', fields: [] },
    { name: 'AppPointer', fields: [] },
    { name: 'Profile', fields: [] },
    { name: 'ContactList', fields: [] },
    { name: 'HomeIndex', fields: [] },
    { name: 'Capability', fields: [] },
    { name: 'CapabilityIndex', fields: [] },
  ],
  Permission: [
    { name: 'Read', fields: [] },
    { name: 'Write', fields: [] },
    { name: 'Publish', fields: [] },
  ],
  Resource: [
    { name: 'Object', fields: [['0', k.string]] },
    { name: 'SharedName', fields: [['owner', k.string], ['name', k.string]] },
    { name: 'Channel', fields: [['0', k.string]] },
  ],
};

// ---------------------------------------------------------------------------
// Writer / Reader
// ---------------------------------------------------------------------------

export class Writer {
  private chunks: number[] = [];

  push(...bytes: number[]): void {
    this.chunks.push(...bytes);
  }

  u8(v: number): void {
    this.push(v & 0xff);
  }

  u32(v: number): void {
    this.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  }

  u64(v: number): void {
    const lo = v % 0x100000000;
    const hi = Math.floor(v / 0x100000000);
    this.push(
      lo & 0xff,
      (lo >>> 8) & 0xff,
      (lo >>> 16) & 0xff,
      (lo >>> 24) & 0xff,
      hi & 0xff,
      (hi >>> 8) & 0xff,
      (hi >>> 16) & 0xff,
      (hi >>> 24) & 0xff
    );
  }

  bool(b: boolean): void {
    this.u8(b ? 1 : 0);
  }

  str(s: string): void {
    const bytes = Buffer.from(s, 'utf8');
    this.u64(bytes.length);
    this.push(...bytes);
  }

  bytes(b: Uint8Array | number[]): void {
    this.u64(b.length);
    this.push(...b);
  }

  bytesN(b: Uint8Array | number[]): void {
    this.push(...b);
  }

  raw(b: Uint8Array): void {
    this.push(...b);
  }

  toBuffer(): Buffer {
    return Buffer.from(this.chunks);
  }

  get length(): number {
    return this.chunks.length;
  }
}

export class Reader {
  private pos = 0;
  constructor(private buf: Buffer) {}

  u8(): number {
    return this.buf[this.pos++];
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u32(): number {
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v >>> 0;
  }

  u64(): number {
    const v = this.buf.readBigUInt64LE(this.pos);
    this.pos += 8;
    return Number(v);
  }

  str(): string {
    const len = this.u64();
    const s = this.buf.subarray(this.pos, this.pos + len).toString('utf8');
    this.pos += len;
    return s;
  }

  bytes(): Buffer {
    const len = this.u64();
    const b = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return Buffer.from(b);
  }

  bytesN(n: number): Buffer {
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return Buffer.from(b);
  }

  peek(): number {
    return this.buf[this.pos];
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  get done(): boolean {
    return this.pos >= this.buf.length;
  }
}

// ---------------------------------------------------------------------------
// Value shapes
// ---------------------------------------------------------------------------

/**
 * The language-neutral value shape mirrors what `serde_json` produces for the
 * Rust types:
 *   - struct → `{ field: value, ... }`
 *   - newtype wrappers (ObjectId…) → plain string
 *   - unit enum variant → `"Variant"`
 *   - data enum variant → `{ "Variant": { field: value, ... } }`
 *   - `[u8; n]` / `Vec<u8>` → array of bytes
 *   - `Option` → `null` or the value
 *   - map → `{ "key": value, ... }`
 */

export type WireValue = string | number | boolean | null | WireValue[] | { [k: string]: WireValue };

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

function codecFor(kind: WireKind): Codec {
  if (kind.t === 'struct') {
    const fields = STRUCTS[kind.name];
    if (!fields) throw new Error(`unknown struct ${kind.name}`);
    return new Codec(kind, fields, kind.name, 'v');
  }
  if (kind.t === 'enum') {
    const def = ENUMS[kind.name];
    if (!def) throw new Error(`unknown enum ${kind.name}`);
    return new Codec(kind, def, kind.name, 'e');
  }
  throw new Error(`cannot query a type codec for primitive ${kind.t}`);
}

class TypeCodec {
  constructor(
    readonly kind: WireKind,
    private readonly fieldsOrVariants: WireField[] | WireEnumVariant[],
    readonly name: string,
    readonly mode: 'v' | 'e'
  ) {}

  encode(w: Writer, value: WireValue, path: string): void {
    if (this.mode === 'v') {
      const fields = this.fieldsOrVariants as WireField[];
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${path}: expected struct object, got ${JSON.stringify(value)}`);
      }
      const obj = value as Record<string, WireValue>;
      for (const [fname, fkind] of fields) {
        if (!(fname in obj)) throw new Error(`${path}.${fname}: missing field`);
        encodeValue(w, fkind, obj[fname], `${path}.${fname}`);
      }
      return;
    }
    const variants = this.fieldsOrVariants as WireEnumVariant[];
    const idx = variantIndex(variants, value, path);
    w.u32(idx);
    const variant = variants[idx];
    if (variant.fields.length === 0) return;
    if (isNewtype(variant)) {
      // serde encodes a newtype variant's payload directly; the JSON shape
      // is `{ "Variant": <inner value> }`.
      encodeValue(w, variant.fields[0]![1], (value as Record<string, WireValue>)[variant.name], `${path}.${variant.name}`);
      return;
    }
    const data = (value as Record<string, WireValue>)[variant.name];
    const obj = data === null || data === undefined ? null : (data as Record<string, WireValue>);
    for (const [fname, fkind] of variant.fields) {
      const fv = obj === null ? undefined : obj[fname];
      encodeValue(w, fkind, fv ?? null, `${path}.${variant.name}.${fname}`);
    }
  }

  decode(r: Reader): WireValue {
    if (this.mode === 'v') {
      const fields = this.fieldsOrVariants as WireField[];
      const out: Record<string, WireValue> = {};
      for (const [fname, fkind] of fields) {
        out[fname] = decodeValue(r, fkind, this.name);
      }
      return out;
    }
    const variants = this.fieldsOrVariants as WireEnumVariant[];
    const idx = r.u32();
    if (idx >= variants.length) {
      throw new Error(`${this.name}: unknown variant tag ${idx}`);
    }
    const variant = variants[idx];
    if (variant.fields.length === 0) return variant.name;
    if (isNewtype(variant)) {
      return { [variant.name]: decodeValue(r, variant.fields[0]![1], `${this.name}.${variant.name}`) };
    }
    const inner: Record<string, WireValue> = {};
    for (const [fname, fkind] of variant.fields) {
      inner[fname] = decodeValue(r, fkind, `${this.name}.${variant.name}`);
    }
    return { [variant.name]: inner };
  }
}

/** True when a variant is a Rust newtype (single unnamed field). */
function isNewtype(variant: WireEnumVariant): boolean {
  return variant.fields.length === 1 && variant.fields[0]![0] === '0';
}

class Codec extends TypeCodec {}

function variantIndex(variants: WireEnumVariant[], value: WireValue, path: string): number {
  if (typeof value === 'string') {
    const i = variants.findIndex((v) => v.name === value);
    if (i < 0) throw new Error(`${path}: unknown variant "${value}"`);
    return i;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, WireValue>);
    if (keys.length > 0) {
      const i = variants.findIndex((v) => v.name === keys[0]);
      if (i < 0) throw new Error(`${path}: unknown variant "${keys[0]}"`);
      return i;
    }
  }
  throw new Error(`${path}: cannot resolve enum variant from ${JSON.stringify(value)}`);
}

function bytesOf(v: WireValue, path: string): number[] {
  if (Array.isArray(v)) return v as number[];
  if (typeof v === 'string') {
    // hex string convenience (not produced by serde_json, but handy)
    const b = Buffer.from(v, 'hex');
    return [...b];
  }
  throw new Error(`${path}: expected byte array, got ${JSON.stringify(v)}`);
}

export function encodeValue(w: Writer, kind: WireKind, value: WireValue, path: string): void {
  switch (kind.t) {
    case 'u32':
      w.u32(num(value, path));
      break;
    case 'u64':
      w.u64(num(value, path));
      break;
    case 'u8':
      w.u8(num(value, path));
      break;
    case 'bool':
      w.bool(value as boolean);
      break;
    case 'string':
      w.str(value as string);
      break;
    case 'bytes':
      w.bytes(bytesOf(value, path));
      break;
    case 'bytesN':
      w.bytesN(bytesOf(value, path));
      break;
    case 'struct':
      codecFor(kind).encode(w, value, path);
      break;
    case 'enum':
      codecFor(kind).encode(w, value, path);
      break;
    case 'vec': {
      const arr = value as WireValue[];
      w.u64(arr.length);
      for (let i = 0; i < arr.length; i++) encodeValue(w, kind.of, arr[i], `${path}[${i}]`);
      break;
    }
    case 'opt':
      if (value === null || value === undefined) {
        w.u8(0);
      } else {
        w.u8(1);
        encodeValue(w, kind.of, value, path);
      }
      break;
    case 'map': {
      const obj = value as Record<string, WireValue>;
      const keys = Object.keys(obj).sort();
      w.u64(keys.length);
      for (const key of keys) {
        w.str(key);
        encodeValue(w, kind.val, obj[key], `${path}.${key}`);
      }
      break;
    }
    case 'any':
      // Passthrough for opaque fields: bytes as raw (no framing).
      w.raw(Buffer.from(bytesOf(value, path)));
      break;
  }
}

export function decodeValue(r: Reader, kind: WireKind, path: string): WireValue {
  switch (kind.t) {
    case 'u32':
      return r.u32();
    case 'u64':
      return r.u64();
    case 'u8':
      return r.u8();
    case 'bool':
      return r.bool();
    case 'string':
      return r.str();
    case 'bytes':
      return [...r.bytes()];
    case 'bytesN':
      return [...r.bytesN(kind.n)];
    case 'struct':
      return codecFor(kind).decode(r);
    case 'enum':
      return codecFor(kind).decode(r);
    case 'vec': {
      const n = r.u64();
      const out: WireValue[] = [];
      for (let i = 0; i < n; i++) out.push(decodeValue(r, kind.of, `${path}[${i}]`));
      return out;
    }
    case 'opt':
      return r.u8() === 0 ? null : decodeValue(r, kind.of, `${path}`);
    case 'map': {
      const n = r.u64();
      const out: Record<string, WireValue> = {};
      for (let i = 0; i < n; i++) {
        const key = r.str();
        out[key] = decodeValue(r, kind.val, `${path}.${key}`);
      }
      return out;
    }
    case 'any':
      return [...r.bytes()];
  }
}

function num(v: WireValue, path: string): number {
  if (typeof v !== 'number') throw new Error(`${path}: expected number, got ${JSON.stringify(v)}`);
  return v;
}

// ---------------------------------------------------------------------------
// Command / response tables
// ---------------------------------------------------------------------------

export const NODE_COMMAND: WireEnumVariant[] = [
  { name: 'Put', fields: [['data', k.bytes], ['name', k.opt(k.string)]] },
  { name: 'PutObject', fields: [['data', k.bytes], ['object_type', k.enm('ObjectType')], ['name', k.opt(k.string)]] },
  { name: 'Concat', fields: [['ids', k.vec(k.string)], ['name', k.opt(k.string)]] },
  { name: 'Get', fields: [['id', k.string]] },
  { name: 'List', fields: [] },
  { name: 'DeleteObject', fields: [['id', k.string]] },
  { name: 'SetName', fields: [['id', k.string], ['name', k.string]] },
  { name: 'Export', fields: [['id', k.string]] },
  { name: 'Import', fields: [['bundle', k.struct('ExportBundle')]] },
  { name: 'Status', fields: [] },
  { name: 'Identity', fields: [] },
  { name: 'Shutdown', fields: [] },
  { name: 'Dial', fields: [['addr', k.string]] },
  { name: 'ListenViaRelay', fields: [['relay_addr', k.string]] },
  { name: 'Publish', fields: [['topic', k.string], ['data', k.bytes]] },
  { name: 'Subscribe', fields: [['topic', k.string]] },
  { name: 'Peers', fields: [] },
  { name: 'RelayReservations', fields: [] },
  { name: 'FindProviders', fields: [['id', k.string]] },
  { name: 'FetchObject', fields: [['peer_id', k.string], ['id', k.string]] },
  { name: 'Announce', fields: [['id', k.string]] },
  { name: 'PublishAppPointer', fields: [['name', k.string], ['manifest', k.string]] },
  { name: 'ResolveAppPointer', fields: [['owner', k.string], ['name', k.string]] },
  { name: 'PublishPointer', fields: [['name', k.string], ['target', k.string]] },
  { name: 'ResolvePointer', fields: [['owner', k.string], ['name', k.string]] },
  { name: 'SaveProfile', fields: [['profile', k.struct('Profile')]] },
  { name: 'LoadProfile', fields: [] },
  { name: 'SaveContactList', fields: [['list', k.struct('ContactList')]] },
  { name: 'LoadContactList', fields: [] },
  { name: 'SaveHomeIndex', fields: [['index', k.struct('HomeIndex')]] },
  { name: 'LoadHomeIndex', fields: [] },
  { name: 'SetHomeEntryShared', fields: [['name', k.string], ['shared', k.bool]] },
  { name: 'DhPublicKey', fields: [] },
  { name: 'PutObjectPublic', fields: [['data', k.bytes], ['object_type', k.enm('ObjectType')], ['name', k.opt(k.string)]] },
  { name: 'ShareObject', fields: [['name', k.string], ['object', k.string], ['app', k.opt(k.string)], ['recipients', k.vec(DH_KEY)]] },
  { name: 'ClaimUsername', fields: [['username', k.string]] },
  { name: 'ResolveUsername', fields: [['username', k.string]] },
  { name: 'ResolveProfile', fields: [['owner', k.string]] },
  { name: 'ExportIdentity', fields: [['passphrase', k.string]] },
  { name: 'ImportIdentity', fields: [['bytes', k.bytes], ['passphrase', k.string], ['overwrite', k.bool]] },
  { name: 'ShowUsername', fields: [] },
  { name: 'Device', fields: [] },
  { name: 'DeviceList', fields: [] },
  { name: 'ResolveOwnerDevice', fields: [['owner', k.string]] },
  { name: 'AddDevice', fields: [['device_id', k.string], ['device_name', k.string]] },
  { name: 'RemoveDevice', fields: [['device_id', k.string]] },
  { name: 'InitiatePairing', fields: [] },
  { name: 'CompletePairing', fields: [['qr', k.struct('PairingQrData')], ['code', k.string]] },
  { name: 'SyncFromPeer', fields: [['peer_id', k.string]] },
  { name: 'SyncDeviceList', fields: [] },
  { name: 'GrantCapability', fields: [['subject', k.string], ['resource', k.enm('Resource')], ['permissions', k.vec(k.enm('Permission'))], ['expires_at', k.opt(k.u64)]] },
  { name: 'ListCapabilities', fields: [] },
  { name: 'RevokeCapability', fields: [['id', k.string]] },
  { name: 'CheckCapability', fields: [['capability', k.struct('Capability')]] },
  { name: 'CheckAccess', fields: [['subject', k.string], ['permission', k.enm('Permission')], ['resource', k.enm('Resource')]] },
  { name: 'StartServeSession', fields: [['edge_addr', k.string], ['app_id', k.string]] },
  { name: 'StopServeSession', fields: [] },
];

export const NODE_RESPONSE: WireEnumVariant[] = [
  { name: 'ObjectCreated', fields: [['id', k.string]] },
  { name: 'DhPublicKey', fields: [['key', DH_KEY]] },
  { name: 'Concatenated', fields: [['id', k.string]] },
  { name: 'NameSet', fields: [] },
  { name: 'Object', fields: [['object', k.struct('Object')]] },
  { name: 'Objects', fields: [['objects', k.vec(k.struct('ObjectInfo'))]] },
  { name: 'ObjectDeleted', fields: [] },
  { name: 'Exported', fields: [['bundle', k.struct('ExportBundle')]] },
  { name: 'Imported', fields: [] },
  { name: 'Status', fields: [['identity', k.string], ['objects', k.u64], ['peers', k.u64]] },
  { name: 'Error', fields: [['message', k.string]] },
  { name: 'Identity', fields: [['identity_id', k.string]] },
  { name: 'ShutdownAccepted', fields: [] },
  { name: 'Dialed', fields: [] },
  { name: 'ListeningViaRelay', fields: [] },
  { name: 'Published', fields: [] },
  { name: 'Subscribed', fields: [] },
  { name: 'PubSub', fields: [['0', k.struct('PubSubMessage')]] },
  { name: 'Peers', fields: [['peers', k.vec(k.struct('PeerInfo'))]] },
  { name: 'RelayReservations', fields: [['reservations', k.vec(k.struct('RelayReservationInfo'))]] },
  { name: 'Providers', fields: [['peer_ids', k.vec(k.string)]] },
  { name: 'Announced', fields: [] },
  { name: 'AppPointerPublished', fields: [] },
  { name: 'AppPointer', fields: [['record', k.opt(k.struct('AppPointerRecord'))]] },
  { name: 'PointerPublished', fields: [] },
  { name: 'Pointer', fields: [['record', k.opt(k.struct('AppPointerRecord'))]] },
  { name: 'ProfileSaved', fields: [['id', k.string]] },
  { name: 'Profile', fields: [['profile', k.opt(k.struct('Profile'))]] },
  { name: 'ContactListSaved', fields: [['id', k.string]] },
  { name: 'ContactList', fields: [['list', k.opt(k.struct('ContactList'))]] },
  { name: 'HomeIndexSaved', fields: [['id', k.string]] },
  { name: 'HomeIndex', fields: [['index', k.opt(k.struct('HomeIndex'))]] },
  { name: 'UsernameClaimed', fields: [] },
  { name: 'Username', fields: [['username', k.opt(k.string)]] },
  { name: 'UsernameOwner', fields: [['owner', k.opt(k.string)]] },
  { name: 'IdentityExported', fields: [['bytes', k.bytes]] },
  { name: 'IdentityImported', fields: [['identity_id', k.string]] },
  { name: 'Device', fields: [['peer_id', k.string], ['device_name', k.string]] },
  { name: 'DeviceList', fields: [['devices', k.vec(k.struct('DeviceInfo'))]] },
  { name: 'OwnerDevice', fields: [['peer_id', k.opt(k.string)]] },
  { name: 'DeviceAdded', fields: [] },
  { name: 'DeviceRemoved', fields: [] },
  { name: 'PairingQr', fields: [['qr', k.struct('PairingQrData')]] },
  { name: 'PairingComplete', fields: [['message', k.string]] },
  { name: 'SyncComplete', fields: [['result', k.struct('SyncResult')]] },
  { name: 'CapabilityGranted', fields: [['capability', k.struct('Capability')]] },
  { name: 'Capabilities', fields: [['index', k.opt(k.struct('CapabilityIndex'))]] },
  { name: 'CapabilityRevoked', fields: [] },
  { name: 'CapabilityCheck', fields: [['valid', k.bool], ['reason', k.string]] },
  { name: 'AccessAllowed', fields: [['allowed', k.bool]] },
  { name: 'ServeSessionStarted', fields: [['app_id', k.string], ['root_url', k.string]] },
  { name: 'ServeSessionStopped', fields: [] },
];

function variantCodec(variants: WireEnumVariant[]): TypeCodec {
  return new TypeCodec({ t: 'enum', name: 'variant' }, variants, 'variant', 'e');
}

export function encodeEnumVariants(variants: WireEnumVariant[], value: WireValue): Buffer {
  const w = new Writer();
  variantCodec(variants).encode(w, value, 'command');
  return w.toBuffer();
}

export function decodeEnumVariants(variants: WireEnumVariant[], buf: Buffer): WireValue {
  return variantCodec(variants).decode(new Reader(buf));
}

export const encodeCommand = (value: WireValue): Buffer => encodeEnumVariants(NODE_COMMAND, value);
export const decodeCommand = (buf: Buffer): WireValue => decodeEnumVariants(NODE_COMMAND, buf);
export const encodeResponse = (value: WireValue): Buffer => encodeEnumVariants(NODE_RESPONSE, value);
export const decodeResponse = (buf: Buffer): WireValue => decodeEnumVariants(NODE_RESPONSE, buf);
export const encodeStruct = (name: string, value: WireValue): Buffer => {
  const w = new Writer();
  codecFor({ t: 'struct', name }).encode(w, value, name);
  return w.toBuffer();
};
export const decodeStruct = (name: string, buf: Buffer): WireValue => codecFor({ t: 'struct', name }).decode(new Reader(buf));

/** Frames a payload the way the node's transport does: u32 LE length + payload. */
export function frame(payload: Buffer): Buffer {
  const out = Buffer.alloc(4 + payload.length);
  out.writeUInt32LE(payload.length, 0);
  payload.copy(out, 4);
  return out;
}

/** Splits a byte stream into frames; incomplete trailing data is held back. */
export class FrameDecoder {
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
    const frames: Buffer[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (this.buf.length < 4 + len) break;
      frames.push(Buffer.from(this.buf.subarray(4, 4 + len)));
      this.buf = Buffer.from(this.buf.subarray(4 + len));
    }
    return frames;
  }
}

/** Convenience: `[u8; n]`/`Vec<u8>` bytes to/from the array value shape. */
export const bytesToValue = (b: Uint8Array): number[] => [...b];
export const valueToBytes = (v: WireValue): Buffer => Buffer.from(bytesOf(v, 'bytes'));
export const bytes32ToValue = bytesToValue;
export const valueToBytes32 = valueToBytes;