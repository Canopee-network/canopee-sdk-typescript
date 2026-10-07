/**
 * Typed model of the Canopee wire protocol.
 *
 * Field names use camelCase for JS ergonomics; when commands/responses are
 * encoded for the wire (bin/`serde_json` value shape) they are translated to
 * the Rust snake_case names, so bytes and JSON always match the node and the
 * golden fixture.
 */

import {
  WireValue,
  decodeStruct,
  encodeStruct,
  bytesToValue,
  valueToBytes,
} from './codec';

// ---------------------------------------------------------------------------
// Newtype ids and raw types
// ---------------------------------------------------------------------------

/** Content-addressed object id (hex sha256), mirrors the Rust `ObjectId` newtype. */
export type ObjectId = string;
/** Identity id (e.g. `canopee://identity/...`), mirrors the Rust `IdentityId` newtype. */
export type IdentityId = string;
/** Capability id, mirrors the Rust `CapabilityId` newtype. */
export type CapabilityId = string;
export type DhPublicKey = number[]; // [u8; 32]

// ---------------------------------------------------------------------------
// Storage / identity model
// ---------------------------------------------------------------------------

export enum ObjectType {
  Blob = 'Blob',
  AppManifest = 'AppManifest',
  AppPointer = 'AppPointer',
  Profile = 'Profile',
  ContactList = 'ContactList',
  HomeIndex = 'HomeIndex',
  Capability = 'Capability',
  CapabilityIndex = 'CapabilityIndex',
}

export interface ObjectMetadata {
  createdAt: number; // u64
  size: number; // u64
  contentType: string | null;
}

export interface ObjectPayload {
  owner: IdentityId;
  metadata: ObjectMetadata;
  objectType: ObjectType;
  data: number[]; // Vec<u8>
}

export interface ObjectInfo {
  id: ObjectId;
  owner: IdentityId;
  size: number; // u64
  verified: boolean;
  name: string | null;
  objectType: ObjectType;
}

export interface StoredObject {
  id: ObjectId;
  payload: ObjectPayload;
  publicKey: number[]; // signature key
  signature: number[];
}

export interface ExportBundle {
  version: number;
  object: StoredObject;
}

export interface Profile {
  displayName: string;
  dhPublicKey: DhPublicKey;
  avatar: ObjectId | null;
  version: number;
}

export interface CapabilityEntry {
  capability: Capability;
  revoked: boolean;
}

export interface CapabilityIndex {
  entries: CapabilityEntry[];
  version: number;
}

export enum Permission {
  Read = 'Read',
  Write = 'Write',
  Publish = 'Publish',
}

export interface Resource {
  // Externally-tagged: exactly one key is present.
  [kind: string]: WireValue;
}

export interface Capability {
  id: CapabilityId;
  issuer: IdentityId;
  subject: IdentityId;
  resource: Resource;
  permissions: Permission[];
  issuedAt: number;
  expiresAt: number | null;
  publicKey: number[];
  signature: number[];
}

// ---------------------------------------------------------------------------
// Network model
// ---------------------------------------------------------------------------

export interface Contact {
  name: string;
  peerId: string;
  dhPublicKey: DhPublicKey;
  note: string | null;
}

export interface ContactList {
  contacts: Contact[];
  version: number;
}

export interface HomeEntry {
  name: string;
  object: ObjectId;
  objectType: ObjectType;
  shared: boolean;
  app: string | null;
}

export interface HomeIndex {
  profile: ObjectId | null;
  contacts: ObjectId | null;
  entries: HomeEntry[];
  version: number;
}

export interface PeerInfo {
  peerId: string;
  identity: string | null;
  username: string | null;
  displayName: string | null;
  addresses: string[];
}

export interface RelayReservationInfo {
  relayPeerId: string;
  renewal: boolean;
  listenAddrs: string[];
}

export interface PubSubMessage {
  topic: string;
  source: string | null;
  data: number[];
}

// ---------------------------------------------------------------------------
// Devices / pairing
// ---------------------------------------------------------------------------

export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
}

export interface PairingQrData {
  version: number;
  deviceId: string;
  deviceName: string;
  lanAddr: string;
  code: string;
  sessionId: string;
}

export interface PairingRecord {
  name: string;
  object: StoredObject;
  pointer: AppPointerRecord;
}

export interface PairingData {
  version: number;
  identityKey: number[];
  records: PairingRecord[];
}

// ---------------------------------------------------------------------------
// Pointers / manifests
// ---------------------------------------------------------------------------

export interface AppManifest {
  name: string;
  owner: IdentityId;
  entrypoint: ObjectId;
  /** key = asset path; the node writes maps sorted for stable bytes. */
  assets: Record<string, ObjectId>;
}

export interface AppPointerRecord {
  name: string;
  owner: IdentityId;
  manifest: ObjectId;
  publishedAt: number;
  publicKey: number[];
  signature: number[];
}

export interface NodeStatus {
  identity: IdentityId;
  objects: number;
  peers: number;
}

export interface SyncResult {
  profileUpdated: boolean;
  contactsUpdated: boolean;
  devicesUpdated: boolean;
}

export interface Device {
  peerId: string;
  deviceName: string;
}

// ---------------------------------------------------------------------------
// Wire shape converters (snake_case value shapes) — built from camelCase
// ---------------------------------------------------------------------------

export function encodeWire(name: string, value: unknown): Buffer {
  return encodeStruct(name, toWire(value));
}

export function decodeWire<T>(name: string, buf: Buffer): T {
  return fromWire(decodeStruct(name, buf)) as T;
}

/** Translates a camelCase typed object into the wire value shape. */
export function toWire(value: unknown): WireValue {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(toWire);
  if (typeof value === 'object') {
    const out: Record<string, WireValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[toSnake(k)] = toWire(v);
    }
    return out;
  }
  return value as WireValue;
}

/** Translates a wire value shape into a camelCase object. */
export function fromWire(value: WireValue): unknown {
  if (Array.isArray(value)) return value.map((v) => fromWire(v as WireValue));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[toCamel(k)] = fromWire(v);
  }
  return out;
}

function toSnake(s: string): string {
  return s.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
}

function toCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

// Convenience converters for byte arrays in typed->wire direction. Typed
// model uses `number[]` for all byte fields, which matches the wire shape, so
// no conversion is needed beyond shape translation.

export {
  bytesToValue,
  valueToBytes,
};