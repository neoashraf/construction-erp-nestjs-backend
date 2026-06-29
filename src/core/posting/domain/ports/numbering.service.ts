/**
 * NumberingService — domain PORT (pure; no NestJS/TypeORM). Declared alongside the posting ports so
 * `PostingService` (LED) depends only on the interface (skill §5.2). NUM supplies the implementation.
 *
 * `next(...)` allocates the next gapless legal number for the `(company, financial year, voucher type)`
 * series. It MUST run inside the caller's `UnitOfWork` transaction: it locks the counter row
 * `SELECT … FOR UPDATE` and the increment commits/rolls back with the enclosing transaction
 * (FR-NUM-008, FR-NUM-009, FR-NUM-010). Returns the formatted number, e.g. `IPC/2526/0001`.
 */
import { VoucherType } from '../voucher-type';

export interface NumberingService {
  next(voucherType: VoucherType, companyId: string, fyId: string): Promise<string>;
}

/** DI token for the NumberingService port. */
export const NUMBERING_SERVICE = Symbol('NumberingService');
