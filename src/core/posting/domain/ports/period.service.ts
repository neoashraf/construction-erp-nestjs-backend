/**
 * PeriodService — domain PORT (pure; skill §5.2). Declared with the posting ports so PostingService
 * (LED) depends only on the interface; PER's `application/` supplies the adapter. `PostingService`
 * calls `assertOpen` inside the post transaction on BOTH post and reverse, BEFORE numbering — so a
 * write into a closed/undefined period is rejected with no journal entry and no number consumed
 * (FR-PER-005/006/007).
 *
 * Resolves (company, FY, voucherDate) → owning period and returns for OPEN; throws `PeriodClosedError`
 * (`PERIOD_CLOSED`) when CLOSED and `NoPeriodDefinedError` (`NO_PERIOD_DEFINED`) when no period owns
 * the date — distinct codes. `voucherDate` is `YYYY-MM-DD`.
 */
export interface PeriodService {
  assertOpen(companyId: string, financialYearId: string, voucherDate: string): Promise<void>;
}

/** DI token for the PeriodService port. */
export const PERIOD_SERVICE = Symbol('PeriodService');
