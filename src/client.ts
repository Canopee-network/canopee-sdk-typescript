/**
 * The Canopee Node client.
 *
 * Talks to a running `canopee-node` over its Unix socket. Like the Rust SDK,
 * every request/response call opens its own connection and closes it after
 * the single reply; only `subscribe()` keeps a persistent stream.
 *
 * Wire framing is identical to the node's transport:
 *   `u32 LE <payload-len>` + bincode-payload (see `codec.ts`).
 */

import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  NODE_COMMAND,
  NODE_RESPONSE,
  WireValue,
  decodeEnumVariants,
  encodeEnumVariants,
  FrameDecoder,
  frame,
} from './codec';
import { fromWire } from './types';
import type {
  Capability,
  CapabilityIndex,
  Contact,
  ContactList,
  Device,
  DeviceInfo,
  ExportBundle,
  HomeIndex,
  IdentityId,
  NodeStatus,
  ObjectId,
  ObjectInfo,
  ObjectType,
  PairingQrData,
  PeerInfo,
  Permission,
  Profile,
  PubSubMessage,
  RelayReservationInfo,
  Resource,
  StoredObject,
  SyncResult,
  AppPointerRecord,
} from './types';

export class CanopeeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanopeeError';
  }
}

export class NodeNotRunningError extends CanopeeError {
  constructor() {
    super('Canopee node is not running');
    this.name = 'NodeNotRunningError';
  }
}

function defaultSocketPath(): string {
  const base = process.env.CANOPEE_APP_ROOT ?? os.homedir();
  return path.join(base, '.canopee', 'node.sock');
}

export class CanopeeClient {
  constructor(public readonly socketPath: string = defaultSocketPath()) {}

  // -------------------------------------------------------------------------
  // Transport plumbing
  // -------------------------------------------------------------------------

  /**
   * Sends a command payload, waits for the node's single reply frame, and
   * returns the response payload (converted to camelCase fields). Throws
   * {@link CanopeeError} when the node replies `Error` or when the socket is
   * gone. `expect` (a response variant name or list) is enforced: the reply
   * is unwrapped to that variant's payload.
   */
  private async request(payload: Buffer, expect?: string | string[]): Promise<any> {
    const sock = await connect(this.socketPath);
    let reply: Buffer | undefined;
    try {
      await writeFrame(sock, payload);
      const frames = await readFrames(sock, 1);
      reply = frames[0];
    } finally {
      sock.destroy();
    }
    if (!reply) throw new CanopeeError('closed before a response');
    const value = decodeEnumVariants(NODE_RESPONSE, reply);
    const inner = unwrap(value, expect);
    return fromWire(inner);
  }

  /** Builds a `NodeCommand` payload (serde_json value shape). */
  private cmd(variant: string, fields?: Record<string, unknown>): Buffer {
    const value: WireValue = fields ? { [variant]: fields as Record<string, WireValue> } : variant;
    return encodeEnumVariants(NODE_COMMAND, value);
  }

  private async id(cmd: Buffer, expect: string): Promise<ObjectId> {
    const payload = await this.request(cmd, expect);
    return payload.id;
  }

  // -------------------------------------------------------------------------
  // Storage
  // -------------------------------------------------------------------------

  async put(data: number[], name?: string): Promise<ObjectId> {
    return this.id(this.cmd('Put', { data, name: name ?? null }), 'ObjectCreated');
  }

  async putObject(data: number[], objectType: ObjectType, name?: string): Promise<ObjectId> {
    return this.id(this.cmd('PutObject', { data, object_type: objectType, name: name ?? null }), 'ObjectCreated');
  }

  async concat(ids: ObjectId[], name?: string): Promise<ObjectId> {
    return this.id(this.cmd('Concat', { ids, name: name ?? null }), 'Concatenated');
  }

  async get(id: ObjectId): Promise<StoredObject> {
    const p = await this.request(this.cmd('Get', { id }), 'Object');
    return p.object as StoredObject;
  }

  async list(): Promise<ObjectInfo[]> {
    const p = await this.request(this.cmd('List'), 'Objects');
    return p.objects as ObjectInfo[];
  }

  async deleteObject(id: ObjectId): Promise<boolean> {
    await this.request(this.cmd('DeleteObject', { id }), 'ObjectDeleted');
    return true;
  }

  async setName(id: ObjectId, name: string): Promise<boolean> {
    await this.request(this.cmd('SetName', { id, name }), 'NameSet');
    return true;
  }

  async exportObject(id: ObjectId): Promise<ExportBundle> {
    const p = await this.request(this.cmd('Export', { id }), 'Exported');
    return p.bundle as ExportBundle;
  }

  async importObject(bundle: ExportBundle): Promise<boolean> {
    await this.request(this.cmd('Import', { bundle }), 'Imported');
    return true;
  }

  // -------------------------------------------------------------------------
  // Runtime / identity
  // -------------------------------------------------------------------------

  async status(): Promise<NodeStatus> {
    return (await this.request(this.cmd('Status'), 'Status')) as NodeStatus;
  }

  async identity(): Promise<IdentityId> {
    return (await this.request(this.cmd('Identity'), 'Identity')).identityId;
  }

  async shutdown(): Promise<void> {
    await this.request(this.cmd('Shutdown'), 'ShutdownAccepted');
  }

  async dhPublicKey(): Promise<number[]> {
    return (await this.request(this.cmd('DhPublicKey'), 'DhPublicKey')).key;
  }

  async saveProfile(profile: Profile): Promise<ObjectId> {
    return this.id(this.cmd('SaveProfile', { profile }), 'ProfileSaved');
  }

  async loadProfile(): Promise<Profile | null> {
    return (await this.request(this.cmd('LoadProfile'), 'Profile')).profile;
  }

  async saveContactList(list: ContactList): Promise<ObjectId> {
    return this.id(this.cmd('SaveContactList', { list }), 'ContactListSaved');
  }

  async loadContactList(): Promise<ContactList | null> {
    return (await this.request(this.cmd('LoadContactList'), 'ContactList')).list;
  }

  async saveHomeIndex(index: HomeIndex): Promise<ObjectId> {
    return this.id(this.cmd('SaveHomeIndex', { index }), 'HomeIndexSaved');
  }

  async loadHomeIndex(): Promise<HomeIndex | null> {
    return (await this.request(this.cmd('LoadHomeIndex'), 'HomeIndex')).index;
  }

  async setHomeEntryShared(name: string, shared: boolean): Promise<boolean> {
    await this.request(this.cmd('SetHomeEntryShared', { name, shared }), 'NameSet');
    return true;
  }

  async exportIdentity(passphrase: string): Promise<number[]> {
    return (await this.request(this.cmd('ExportIdentity', { passphrase }), 'IdentityExported')).bytes;
  }

  async importIdentity(bytes: number[], passphrase: string, overwrite: boolean): Promise<IdentityId> {
    return (await this.request(this.cmd('ImportIdentity', { bytes, passphrase, overwrite }), 'IdentityImported')).identity_id;
  }

  // -------------------------------------------------------------------------
  // User records across the network
  // -------------------------------------------------------------------------

  async publishPointer(name: string, target: ObjectId): Promise<boolean> {
    await this.request(this.cmd('PublishPointer', { name, target }), 'PointerPublished');
    return true;
  }

  async publishAppPointer(name: string, manifest: ObjectId): Promise<boolean> {
    await this.request(this.cmd('PublishAppPointer', { name, manifest }), 'AppPointerPublished');
    return true;
  }

  async resolveAppPointer(owner: IdentityId, name: string): Promise<AppPointerRecord | null> {
    return (await this.request(this.cmd('ResolveAppPointer', { owner, name }), 'AppPointer')).record;
  }

  async resolvePointer(owner: IdentityId, name: string): Promise<AppPointerRecord | null> {
    return (await this.request(this.cmd('ResolvePointer', { owner, name }), 'Pointer')).record;
  }

  async claimUsername(username: string): Promise<boolean> {
    await this.request(this.cmd('ClaimUsername', { username }), 'UsernameClaimed');
    return true;
  }

  async resolveUsername(username: string): Promise<IdentityId | null> {
    return (await this.request(this.cmd('ResolveUsername', { username }), 'UsernameOwner')).owner;
  }

  async showUsername(): Promise<string | null> {
    return (await this.request(this.cmd('ShowUsername'), 'Username')).username;
  }

  async resolveProfile(owner: IdentityId): Promise<Profile | null> {
    return (await this.request(this.cmd('ResolveProfile', { owner }), 'Profile')).profile;
  }

  // -------------------------------------------------------------------------
  // Devices & pairing
  // -------------------------------------------------------------------------

  async device(): Promise<Device> {
    return (await this.request(this.cmd('Device'), 'Device')) as Device;
  }

  async deviceList(): Promise<DeviceInfo[]> {
    return (await this.request(this.cmd('DeviceList'), 'DeviceList')).devices;
  }

  async resolveOwnerDevice(owner: IdentityId): Promise<string | null> {
    return (await this.request(this.cmd('ResolveOwnerDevice', { owner }), 'OwnerDevice')).peer_id;
  }

  async addDevice(deviceId: string, deviceName: string): Promise<boolean> {
    await this.request(this.cmd('AddDevice', { device_id: deviceId, device_name: deviceName }), 'DeviceAdded');
    return true;
  }

  async removeDevice(deviceId: string): Promise<boolean> {
    await this.request(this.cmd('RemoveDevice', { device_id: deviceId }), 'DeviceRemoved');
    return true;
  }

  async initiatePairing(): Promise<PairingQrData> {
    return (await this.request(this.cmd('InitiatePairing'), 'PairingQr')).qr;
  }

  async completePairing(qr: PairingQrData, code: string): Promise<string> {
    return (await this.request(this.cmd('CompletePairing', { qr, code }), 'PairingComplete')).message;
  }

  async syncFromPeer(peerId: string): Promise<SyncResult> {
    return (await this.request(this.cmd('SyncFromPeer', { peer_id: peerId }), 'SyncComplete')).result;
  }

  async syncDeviceList(): Promise<SyncResult> {
    return (await this.request(this.cmd('SyncDeviceList'), 'SyncComplete')).result;
  }

  // -------------------------------------------------------------------------
  // Networking / DHT
  // -------------------------------------------------------------------------

  async dial(addr: string): Promise<boolean> {
    await this.request(this.cmd('Dial', { addr }), 'Dialed');
    return true;
  }

  async listenViaRelay(relayAddr: string): Promise<boolean> {
    await this.request(this.cmd('ListenViaRelay', { relay_addr: relayAddr }), 'ListeningViaRelay');
    return true;
  }

  async publish(topic: string, data: number[]): Promise<boolean> {
    await this.request(this.cmd('Publish', { topic, data }), 'Published');
    return true;
  }

  async peers(): Promise<PeerInfo[]> {
    return (await this.request(this.cmd('Peers'), 'Peers')).peers;
  }

  async relayReservations(): Promise<RelayReservationInfo[]> {
    return (await this.request(this.cmd('RelayReservations'), 'RelayReservations')).reservations;
  }

  async findProviders(id: ObjectId): Promise<string[]> {
    return (await this.request(this.cmd('FindProviders', { id }), 'Providers')).peer_ids;
  }

  async fetchObject(peerId: string, id: ObjectId): Promise<StoredObject> {
    return (await this.request(this.cmd('FetchObject', { peer_id: peerId, id }), 'Object')).object;
  }

  async announce(id: ObjectId): Promise<boolean> {
    await this.request(this.cmd('Announce', { id }), 'Announced');
    return true;
  }

  async putObjectPublic(data: number[], objectType: ObjectType, name?: string): Promise<ObjectId> {
    return this.id(this.cmd('PutObjectPublic', { data, object_type: objectType, name: name ?? null }), 'ObjectCreated');
  }

  async shareObject(name: string, object: ObjectId, app?: string, recipients: number[][] = []): Promise<ObjectId> {
    return this.id(this.cmd('ShareObject', { name, object, app: app ?? null, recipients }), 'ObjectCreated');
  }

  /**
   * Subscribes to a topic and yields {@link PubSubMessage}s until the socket
   * closes (node shutdown) or the generator is disposed.
   */
  async *subscribe(topic: string): AsyncGenerator<PubSubMessage> {
    const sock = await connect(this.socketPath);
    const decoder = new FrameDecoder();
    const queue: Buffer[] = [];
    let done = false;
    let error: Error | null = null;
    const wake: (() => void)[] = [];

    const onData = (chunk: Buffer): void => {
      for (const fr of decoder.push(chunk)) queue.push(fr);
      kick();
    };
    const onEnd = (): void => {
      done = true;
      kick();
    };
    const onError = (e: Error): void => {
      error = e;
      done = true;
      kick();
    };
    sock.on('data', onData);
    sock.on('end', onEnd);
    sock.on('error', onError);

    const kick = (): void => {
      for (const fn of wake.splice(0)) fn();
    };
    const nextFrame = async (): Promise<Buffer | undefined> => {
      while (true) {
        if (queue.length) return queue.shift();
        if (done) return undefined;
        await new Promise<void>((resolve) => wake.push(resolve));
        if (error) throw error;
      }
    };

    try {
      await writeFrame(sock, this.cmd('Subscribe', { topic }));
      const first = await nextFrame();
      if (!first) throw new CanopeeError('closed before Subscribed');
      const value = decodeEnumVariants(NODE_RESPONSE, first);
      if (typeof value !== 'string' || !value.endsWith('Subscribed')) {
        throw new CanopeeError(`subscribe rejected: ${JSON.stringify(value)}`);
      }
      while (true) {
        const fr = await nextFrame();
        if (!fr) break;
        const inner = unwrap(decodeEnumVariants(NODE_RESPONSE, fr), 'PubSub');
        yield fromWire(inner) as unknown as PubSubMessage;
      }
    } finally {
      sock.off('data', onData);
      sock.off('end', onEnd);
      sock.off('error', onError);
      sock.destroy();
    }
  }

  // -------------------------------------------------------------------------
  // Capabilities
  // -------------------------------------------------------------------------

  async grantCapability(
    subject: IdentityId,
    resource: Resource,
    permissions: Permission[],
    expiresAt?: number
  ): Promise<Capability> {
    return (
      await this.request(
        this.cmd('GrantCapability', { subject, resource, permissions, expires_at: expiresAt ?? null }),
        'CapabilityGranted'
      )
    ).capability;
  }

  async listCapabilities(): Promise<CapabilityIndex | null> {
    return (await this.request(this.cmd('ListCapabilities'), 'Capabilities')).index;
  }

  async revokeCapability(id: string): Promise<boolean> {
    await this.request(this.cmd('RevokeCapability', { id }), 'CapabilityRevoked');
    return true;
  }

  async checkCapability(capability: Capability): Promise<{ valid: boolean; reason: string }> {
    return (await this.request(this.cmd('CheckCapability', { capability }), 'CapabilityCheck')) as {
      valid: boolean;
      reason: string;
    };
  }

  async checkAccess(subject: IdentityId, permission: Permission, resource: Resource): Promise<boolean> {
    return (await this.request(this.cmd('CheckAccess', { subject, permission, resource }), 'AccessAllowed')).allowed;
  }

  // -------------------------------------------------------------------------
  // Serve sessions
  // -------------------------------------------------------------------------

  async startServeSession(edgeAddr: string, appId: ObjectId): Promise<{ appId: string; rootUrl: string }> {
    return (await this.request(this.cmd('StartServeSession', { edge_addr: edgeAddr, app_id: appId }), 'ServeSessionStarted')) as {
      appId: string;
      rootUrl: string;
    };
  }

  async stopServeSession(): Promise<boolean> {
    await this.request(this.cmd('StopServeSession'), 'ServeSessionStopped');
    return true;
  }
}

// ---------------------------------------------------------------------------
// Socket helpers
// ---------------------------------------------------------------------------

function connect(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path: socketPath });
    const onError = (e: Error & { code?: string }): void => {
      sock.destroy();
      reject(
        e.code === 'ECONNREFUSED' || e.code === 'ENOENT' ? new NodeNotRunningError() : e
      );
    };
    sock.once('error', onError);
    sock.once('connect', () => {
      sock.off('error', onError);
      resolve(sock);
    });
  });
}

function writeFrame(sock: net.Socket, payload: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sock.write(frame(payload), (e) => (e ? reject(e) : resolve()));
  });
}

function readFrames(sock: net.Socket, count: number): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const decoder = new FrameDecoder();
    const frames: Buffer[] = [];
    const onData = (chunk: Buffer): void => {
      for (const fr of decoder.push(chunk)) {
        frames.push(fr);
        if (frames.length === count) {
          cleanup();
          resolve(frames);
        }
      }
    };
    const onError = (e: Error): void => {
      cleanup();
      reject(e);
    };
    const onClose = (): void => {
      cleanup();
      if (frames.length) resolve(frames);
      else reject(new CanopeeError('socket closed before a response'));
    };
    const cleanup = (): void => {
      sock.off('data', onData);
      sock.off('error', onError);
      sock.off('close', onClose);
    };
    sock.on('data', onData);
    sock.on('error', onError);
    sock.on('close', onClose);
  });
}

/** Strips the externally-tagged response down to its payload, throwing on Error. */
function unwrap(value: WireValue, expect?: string | string[]): WireValue {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === 'Error') {
      const msg = (value as Record<string, WireValue>).Error;
      throw new CanopeeError(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    if (expect !== undefined) {
      const wants = Array.isArray(expect) ? expect : [expect];
      if (keys.length === 1 && wants.includes(keys[0]!)) {
        return (value as Record<string, WireValue>)[keys[0]!] as WireValue;
      }
    }
  }
  if (expect !== undefined && typeof value === 'string' && (Array.isArray(expect) ? expect : [expect]).includes(value)) {
    return value;
  }
  if (expect !== undefined) {
    throw new CanopeeError(`unexpected response: ${JSON.stringify(value)}`);
  }
  return value;
}

export { CanopeeClient as default };