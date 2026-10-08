/**
 * Live end-to-end test: drives a real `canopee-node` process (built from the
 * main Canopee repo) purely through the TypeScript SDK, exercising storage,
 * runtime/identity, user records, devices, capabilities and pub/sub the same
 * way the Rust SDK's integration tests do.
 *
 * The node binary is located via `CANOPEE_NODE_BIN` (falls back to
 * `canopee-node` on PATH). The test is skipped when none is available.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { CanopeeClient, ObjectType, Permission } from '../src';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function nodeBinary(): string | null {
  if (process.env.CANOPEE_NODE_BIN) return process.env.CANOPEE_NODE_BIN;
  try {
    const res = spawnSync('canopee-node', ['--version'], { stdio: 'ignore' });
    return res.error ? null : 'canopee-node';
  } catch {
    return null;
  }
}

function spawnNode(root: string): ChildProcess {
  const bin = nodeBinary();
  if (!bin) throw new Error('no canopee-node binary (set CANOPEE_NODE_BIN)');
  const logFd = fs.openSync(path.join(root, 'node.log'), 'a');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CANOPEE_APP_ROOT: root,
    CANOPEE_MDNS: '0',
    CANOPEE_BOOTSTRAP_ADDRS: '',
    RUST_LOG: '',
  };
  const child = spawn(bin, [], { env, stdio: ['ignore', logFd, logFd] });
  child.once('exit', () => {
    try {
      fs.closeSync(logFd);
    } catch {
      /* already closed */
    }
  });
  child.on('error', (e) => {
    try {
      fs.writeSync(logFd, `spawn error: ${e}\n`);
    } catch {
      /* ignore */
    }
  });
  return child;
}

async function waitForSocket(socketPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) return;
    await sleep(100);
  }
  throw new Error(`node socket never appeared at ${socketPath}`);
}

async function stopNode(child: ChildProcess, root: string): Promise<void> {
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([
      new Promise((r) => child.once('exit', r)),
      sleep(2000),
    ]);
  }
  await fs.promises.rm(root, { recursive: true, force: true });
}

test('live node: storage, identity, records, devices, capabilities', { timeout: 90000 }, async () => {
  if (!nodeBinary()) return; // skipped
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopee-e2e-ts-'));
  const prevRoot = process.env.CANOPEE_APP_ROOT;
  process.env.CANOPEE_APP_ROOT = root; // client resolves $CANOPEE_APP_ROOT/.canopee/node.sock
  const child = spawnNode(root);
  const socketPath = path.join(root, '.canopee', 'node.sock');
  try {
    await waitForSocket(socketPath, 30000);
    const client = new CanopeeClient();

    // ---- identity / status ----
    const identity = await client.identity();
    assert.ok(identity.startsWith('canopee://identity/'), `identity uri: ${identity}`);
    const status = await client.status();
    assert.equal(status.identity, identity);
    assert.equal(status.peers, 0);
    assert.ok(status.objects >= 1);

    // ---- storage ----
    const id1 = await client.put([...Buffer.from('live e2e (ts)')]);
    let obj = await client.get(id1);
    assert.equal(Buffer.from(obj.payload.data).toString(), 'live e2e (ts)');
    assert.equal(obj.id, id1);

    await client.setName(id1, 'e2e-name');
    const infos = await client.list();
    const info = infos.find((o) => o.id === id1);
    assert.ok(info, 'stored object must be listed');
    assert.equal(info!.name, 'e2e-name');
    assert.equal(info!.objectType, ObjectType.Blob);

    const a = await client.put([...Buffer.from('hello ')]);
    const b = await client.put([...Buffer.from('world')]);
    const joined = await client.concat([a, b], 'greeting');
    assert.notEqual(joined, a);
    assert.equal(Buffer.from((await client.get(joined)).payload.data).toString(), 'hello world');

    const bundle = await client.exportObject(id1);
    assert.equal(bundle.object.id, id1);
    await client.deleteObject(id1);
    await client.importObject(bundle);
    assert.equal(Buffer.from((await client.get(id1)).payload.data).toString(), 'live e2e (ts)');

    await client.deleteObject(joined);
    await assert.rejects(() => client.get(joined), 'deleted object is gone');
    await assert.rejects(() => client.get('0000000000000000000000000000000000000000000000000000000000000000'));

    // ---- runtime / identity ----
    const key = await client.dhPublicKey();
    assert.equal(key.length, 32);

    assert.equal(await client.loadProfile(), null);
    await client.saveProfile({ displayName: 'alice', dhPublicKey: new Array(32).fill(7), avatar: null, version: 0 });
    let profile = await client.loadProfile();
    assert.equal(profile!.displayName, 'alice');
    assert.equal(profile!.version, 1);
    await client.saveProfile({ displayName: 'alice', dhPublicKey: new Array(32).fill(7), avatar: null, version: 0 });
    profile = await client.loadProfile();
    assert.equal(profile!.version, 2);

    assert.equal(await client.loadContactList(), null);
    await client.saveContactList({
      contacts: [{ name: 'bob', peerId: '12D3KooB', dhPublicKey: new Array(32).fill(9), note: null }],
      version: 0,
    });
    let list = await client.loadContactList();
    assert.equal(list!.contacts[0]!.name, 'bob');
    assert.equal(list!.version, 1);

    const pic = await client.putObject([...Buffer.from('png bytes')], ObjectType.Blob);
    await client.saveHomeIndex({
      profile: null,
      contacts: null,
      entries: [{ name: 'pic.png', object: pic, objectType: ObjectType.Blob, shared: false, app: 'e2e' }],
      version: 0,
    });
    let index = await client.loadHomeIndex();
    assert.equal(index!.entries.length, 1);
    assert.equal(index!.entries[0]!.shared, false);
    await client.setHomeEntryShared('pic.png', true);
    index = await client.loadHomeIndex();
    assert.equal(index!.entries[0]!.shared, true);
    await assert.rejects(() => client.setHomeEntryShared('missing', true), 'unknown entry rejected');

    // ---- user records ----
    const ownProfile = await client.resolveProfile(identity);
    assert.ok(ownProfile, 'own profile must resolve after save');
    assert.equal(ownProfile!.displayName, 'alice');

    // Pointers are cached locally and published fire-and-forget on the DHT, so
    // a self publish resolves immediately even with zero peers.
    await client.publishPointer('e2e:demo', id1);
    const rec = await client.resolvePointer(identity, 'e2e:demo');
    assert.ok(rec, 'just-published pointer must resolve');
    assert.equal(rec!.manifest, id1);
    assert.equal(rec!.name, 'e2e:demo');

    // App pointers await the DHT put directly, which needs at least one peer;
    // on a hermetic single node they fail cleanly with the quorum error.
    await assert.rejects(() => client.publishAppPointer('my-app', id1), /quorum/);

    await client.announce(id1);
    assert.equal((await client.peers()).length, 0);

    // publishing with zero subscribers fails cleanly, not hanging
    await assert.rejects(() => client.publish('e2e-topic', [...Buffer.from('ping')]));

    // ---- devices ----
    const dev = await client.device();
    assert.ok(dev.peerId.length > 10);
    assert.ok(dev.deviceName.length > 0);
    const devs = await client.deviceList();
    assert.ok(devs.some((d) => d.deviceId === dev.peerId), 'own device registered');
    const other = '12D3KooWE2eTestDeviceTs';
    await client.addDevice(other, 'e2e-device');
    assert.ok((await client.deviceList()).some((d) => d.deviceId === other));
    await client.removeDevice(other);
    assert.ok(!(await client.deviceList()).some((d) => d.deviceId === other));

    // ---- capabilities ----
    assert.equal(await client.listCapabilities(), null);
    const cap = await client.grantCapability(
      'canopee://identity/bob',
      { Channel: 'team-news' },
      [Permission.Read, Permission.Write]
    );
    assert.deepEqual(cap.permissions, ['Read', 'Write']);
    assert.equal(cap.issuer, identity);
    assert.equal((await client.checkCapability(cap)).valid, true);
    assert.equal(await client.checkAccess('canopee://identity/bob', Permission.Read, { Channel: 'team-news' }), true);
    assert.equal(await client.checkAccess('canopee://identity/bob', Permission.Write, { Channel: 'team-news' }), true);
    assert.equal(await client.checkAccess('canopee://identity/bob', Permission.Publish, { Channel: 'team-news' }), false);
    assert.equal(await client.checkAccess('canopee://identity/mallory', Permission.Read, { Channel: 'team-news' }), false);
    assert.equal(await client.checkAccess('canopee://identity/bob', Permission.Read, { Channel: 'other' }), false);

    let cidx = await client.listCapabilities();
    assert.equal(cidx!.entries.length, 1);
    assert.equal(cidx!.entries[0]!.revoked, false);

    await client.revokeCapability(cap.id);
    cidx = await client.listCapabilities();
    assert.equal(cidx!.entries[0]!.revoked, true);
    const revoked = await client.checkCapability(cap);
    assert.equal(revoked.valid, false);
    assert.ok(revoked.reason.includes('revoked'));
    assert.equal(await client.checkAccess('canopee://identity/bob', Permission.Read, { Channel: 'team-news' }), false);

    // ---- pub/sub (ack + clean close; no message can arrive without peers) ----
    const gen = client.subscribe('e2e-sub');
    await Promise.race([gen.next(), sleep(600)]); // Subscribed ack consumed inside the generator
    await gen.return(undefined);

    await client.shutdown().catch(() => {});
  } finally {
    await stopNode(child, root);
    if (prevRoot === undefined) delete process.env.CANOPEE_APP_ROOT;
    else process.env.CANOPEE_APP_ROOT = prevRoot;
  }
});