import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { ApiService } from '../../api/api.service';
import { AuthService } from '../../core/auth.service';
import { Notify } from '../../core/notify.service';
import { Account } from './account';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const user = { username: 'admin', displayName: 'Admin', role: 'admin', domains: [], mustChangePassword: false };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Account passkey registration feedback', () => {
  const g = globalThis as unknown as { PublicKeyCredential?: unknown };
  let savedPkc: unknown;
  let savedCreate: unknown;

  beforeEach(() => {
    savedPkc = g.PublicKeyCredential;
    savedCreate = navigator.credentials?.create;
    g.PublicKeyCredential = class { static parseCreationOptionsFromJSON = (o: unknown) => o; };
  });

  afterEach(() => {
    g.PublicKeyCredential = savedPkc;
    if (navigator.credentials) navigator.credentials.create = savedCreate as typeof navigator.credentials.create;
  });

  function setup() {
    const device = deferred<unknown>();
    const options = deferred<{ requestId: string; options: object }>();
    const add = deferred<void>();
    const api = {
      passkeyCreateOptions: () => options.promise,
      passkeyAdd: () => add.promise,
      passkeys: () => Promise.resolve([]),
      tokens: () => Promise.resolve([]),
    };
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: { create: () => device.promise },
    });
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: api },
        { provide: AuthService, useValue: { user: () => user, refresh: () => Promise.resolve() } },
        { provide: MatDialog, useValue: {} },
        { provide: Notify, useValue: { info: () => {}, error: () => {} } },
      ],
    });
    const fixture = TestBed.createComponent(Account);
    fixture.detectChanges();
    const cmp = fixture.componentInstance as unknown as {
      pk: { setValue(v: { name: string }): void };
      addPasskey(): Promise<void>;
      pkStep(): string | null;
      busy(): boolean;
    };
    const text = () => fixture.nativeElement.querySelector('[role=status]')?.textContent?.trim() ?? null;
    return { fixture, cmp, device, options, add, text };
  }

  it('shows what is happening while the authenticator prompt is open and clears afterwards', async () => {
    const { fixture, cmp, device, options, add, text } = setup();
    cmp.pk.setValue({ name: 'Laptop' });
    expect(text()).toBeNull();

    const run = cmp.addPasskey();
    fixture.detectChanges();
    expect(cmp.busy()).toBe(true);
    expect(text()).toMatch(/Preparing/);

    options.resolve({ requestId: 'r1', options: { challenge: 'x' } });
    await tick();
    fixture.detectChanges();
    expect(text()).toMatch(/Waiting for your device/);
    expect(fixture.nativeElement.querySelector('mat-progress-bar')).not.toBeNull();

    device.resolve({ id: 'c', toJSON: () => ({ id: 'c' }) });
    await tick();
    fixture.detectChanges();
    expect(text()).toMatch(/Saving/);

    add.resolve();
    await run;
    fixture.detectChanges();
    expect(cmp.busy()).toBe(false);
    expect(text()).toBeNull();
  });

  it('clears the indicator when the user dismisses the prompt', async () => {
    const { fixture, cmp, device, options, text } = setup();
    cmp.pk.setValue({ name: 'Laptop' });
    const run = cmp.addPasskey();
    options.resolve({ requestId: 'r1', options: { challenge: 'x' } });
    await tick();
    fixture.detectChanges();
    expect(text()).toMatch(/Waiting for your device/);

    device.reject(new DOMException('cancelled', 'NotAllowedError'));
    await run;
    fixture.detectChanges();
    expect(cmp.busy()).toBe(false);
    expect(text()).toBeNull();
  });
});
