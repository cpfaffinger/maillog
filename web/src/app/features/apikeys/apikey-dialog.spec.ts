import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { ApiKey, ApiKeyInput } from '../../api/models';
import { ApiKeyDialog } from './apikey-dialog';

const existing: ApiKey = {
  id: 'k1', name: 'danceplus', prefix: 'mlk_ab12', domains: ['danceplus.at'], createdAt: 1, createdBy: 'admin',
  expiresAt: null, lastUsed: null, lastIp: null, useCount: 0,
};

function open(data: ApiKey | null) {
  const closed: (ApiKeyInput | undefined)[] = [];
  TestBed.configureTestingModule({
    providers: [
      { provide: MAT_DIALOG_DATA, useValue: data },
      { provide: MatDialogRef, useValue: { close: (v?: ApiKeyInput) => closed.push(v) } },
    ],
  });
  const fixture = TestBed.createComponent(ApiKeyDialog);
  fixture.detectChanges();
  // the component keeps its state in protected members; reach them like the template does
  return { fixture, cmp: fixture.componentInstance as unknown as {
    form: { setValue(v: { name: string; days: number }): void; patchValue(v: object): void };
    domains: { (): string[]; set(v: string[]): void };
    domainError(): string | null;
    save(): void;
  }, closed };
}

describe('ApiKeyDialog', () => {
  it('refuses to save without a sender domain', () => {
    const { cmp, closed } = open(null);
    cmp.form.patchValue({ name: 'shop' });
    expect(cmp.domainError()).toMatch(/at least one sender domain/);
    cmp.save();
    expect(closed).toEqual([]);
  });

  it('creates with the chosen domains and expiry', () => {
    const { cmp, closed } = open(null);
    cmp.form.setValue({ name: '  shop  ', days: 90 });
    cmp.domains.set(['shop.example']);
    cmp.save();
    expect(closed).toEqual([{ name: 'shop', domains: ['shop.example'], expiresInDays: 90 }]);
  });

  it('"never" leaves out the expiry', () => {
    const { cmp, closed } = open(null);
    cmp.form.setValue({ name: 'shop', days: 0 });
    cmp.domains.set(['shop.example']);
    cmp.save();
    expect('expiresInDays' in closed[0]!).toBe(false);
  });

  it('editing keeps the domains and never sends an expiry', () => {
    const { cmp, closed } = open(existing);
    cmp.save();
    expect(closed).toEqual([{ name: 'danceplus', domains: ['danceplus.at'] }]);
  });
});
