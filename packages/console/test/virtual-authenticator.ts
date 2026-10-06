import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/** Minimal CBOR encoder: unsigned/negative ints, byte strings, text strings, maps. Enough for WebAuthn "none" attestation. */
function cbor(value: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  };
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Uint8Array.from(value)]);
  if (typeof value === 'string') {
    const b = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, b.length), b]);
  }
  if (value instanceof Map) {
    const parts: Uint8Array[] = [head(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return Buffer.concat(parts);
  }
  throw new Error(`cbor: unsupported ${typeof value}`);
}

const b64u = (b: Buffer) => b.toString('base64url');
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

/**
 * Software ES256 authenticator for tests. It doubles as a demonstration of the residual risk the
 * design names: a same-user process can mint a passkey, which is why enrolling a second approver
 * needs an existing approver's signature.
 */
export class VirtualAuthenticator {
  private readonly privateKey: KeyObject;
  private readonly cose: Buffer;
  readonly credentialId = randomBytes(16);
  private counter = 0;

  constructor(private readonly rpId: string, private readonly origin: string) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    this.cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  register(options: { challenge: string }) {
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), idLen, this.credentialId, this.cose]);
    const attestationObject = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      clientExtensionResults: {},
      authenticatorAttachment: 'platform' as const,
      response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attestationObject), transports: ['internal'] },
    };
  }

  authenticate(options: { challenge: string }) {
    this.counter++;
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([0x05]), count]);
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      clientExtensionResults: {},
      authenticatorAttachment: 'platform' as const,
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature) },
    };
  }
}
