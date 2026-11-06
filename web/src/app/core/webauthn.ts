// WebAuthn helpers: converts between the server's JSON (base64url binary fields, WebAuthn Level 3
// JSON representation) and the browser API, with a manual fallback for browsers lacking the JSON helpers.

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function b64urlToBuf(s: string): ArrayBuffer {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export function bufToB64url(buf: ArrayBuffer | null | undefined): string {
  if (!buf) return '';
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;
}

function pkc(): Json {
  return window.PublicKeyCredential as unknown as Json;
}

function descriptors(list: Json[] | undefined): Json[] {
  return (list ?? []).map((c) => ({ ...c, id: b64urlToBuf(c['id']) }));
}

export async function getAssertion(options: Record<string, unknown>): Promise<unknown> {
  const o = options as Json;
  const publicKey: Json =
    typeof pkc()['parseRequestOptionsFromJSON'] === 'function'
      ? pkc()['parseRequestOptionsFromJSON'](o)
      : { ...o, challenge: b64urlToBuf(o['challenge']), allowCredentials: descriptors(o['allowCredentials']) };
  const cred = (await navigator.credentials.get({ publicKey: publicKey as PublicKeyCredentialRequestOptions })) as
    | PublicKeyCredential
    | null;
  if (!cred) throw new Error('No credential was returned');
  const asJson = (cred as unknown as Json)['toJSON'];
  if (typeof asJson === 'function') return asJson.call(cred);
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: bufToB64url(r.clientDataJSON),
      authenticatorData: bufToB64url(r.authenticatorData),
      signature: bufToB64url(r.signature),
      userHandle: r.userHandle ? bufToB64url(r.userHandle) : undefined,
    },
  };
}

export async function createCredential(options: Record<string, unknown>): Promise<unknown> {
  const o = options as Json;
  const publicKey: Json =
    typeof pkc()['parseCreationOptionsFromJSON'] === 'function'
      ? pkc()['parseCreationOptionsFromJSON'](o)
      : {
          ...o,
          challenge: b64urlToBuf(o['challenge']),
          user: { ...o['user'], id: b64urlToBuf(o['user']['id']) },
          excludeCredentials: descriptors(o['excludeCredentials']),
        };
  const cred = (await navigator.credentials.create({ publicKey: publicKey as PublicKeyCredentialCreationOptions })) as
    | PublicKeyCredential
    | null;
  if (!cred) throw new Error('No credential was created');
  const asJson = (cred as unknown as Json)['toJSON'];
  if (typeof asJson === 'function') return asJson.call(cred);
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: bufToB64url(r.clientDataJSON),
      attestationObject: bufToB64url(r.attestationObject),
      transports: typeof r.getTransports === 'function' ? r.getTransports() : [],
    },
  };
}

/** True when the user dismissed the browser's passkey prompt. */
export function isCancelled(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError');
}
