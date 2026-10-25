import { createHash } from 'node:crypto';
import type {
  QboBillInput,
  QboBillPaymentInput,
  QboClient,
  QboCustomerInput,
  QboEntity,
  QboInvoiceInput,
  QboPayment,
  QboPaymentInput,
  QboVendorInput,
} from './types.js';

/**
 * Stand-in for QuickBooks when no Intuit credentials are configured (local / demo). Ids are derived
 * deterministically from the Pro-Cure record id (e.g. "SIM-INV-1042"), so re-pushing the same record
 * yields the same QBO id and the full sync flow — maps, logs, statuses — is demonstrable offline.
 * Updates bump the SyncToken like QBO does. It never reports payments made "in QuickBooks".
 */
const PREFIX: Record<string, string> = {
  customer: 'CUS',
  vendor: 'VEN',
  invoice: 'INV',
  bill: 'BILL',
  payment: 'PMT',
  bill_payment: 'BPMT',
};

export const simulatedId = (entity: keyof typeof PREFIX, localId: string) => {
  const n = Number.parseInt(createHash('sha256').update(localId).digest('hex').slice(0, 8), 16) % 9000;
  return `SIM-${PREFIX[entity]}-${1000 + n}-${localId.slice(0, 4).toUpperCase()}`;
};

export class SimulatedQboClient implements QboClient {
  readonly kind = 'simulated' as const;

  private entity(type: keyof typeof PREFIX, localId: string, existing?: { Id?: string; SyncToken?: string }) {
    if (existing?.Id)
      return {
        Id: existing.Id,
        SyncToken: String(Number(existing.SyncToken ?? '0') + 1),
      } satisfies QboEntity;
    return { Id: simulatedId(type, localId), SyncToken: '0' } satisfies QboEntity;
  }

  async createCustomer(localId: string, _input: QboCustomerInput) {
    return this.entity('customer', localId);
  }
  async createVendor(localId: string, _input: QboVendorInput) {
    return this.entity('vendor', localId);
  }
  async saveInvoice(localId: string, input: QboInvoiceInput) {
    return this.entity('invoice', localId, input);
  }
  async voidInvoice(_localId: string, ref: QboEntity) {
    return { Id: ref.Id, SyncToken: String(Number(ref.SyncToken) + 1) };
  }
  async saveBill(localId: string, input: QboBillInput) {
    return this.entity('bill', localId, input);
  }
  async deleteBill(_localId: string, _ref: QboEntity) {}
  async createPayment(localId: string, _input: QboPaymentInput) {
    return this.entity('payment', localId);
  }
  async createBillPayment(localId: string, _input: QboBillPaymentInput) {
    return this.entity('bill_payment', localId);
  }
  async paymentsSince(_since: string): Promise<QboPayment[]> {
    return [];
  }
}
