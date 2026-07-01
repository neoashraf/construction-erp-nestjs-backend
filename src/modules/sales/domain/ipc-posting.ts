/**
 * buildIpcCommand — the ONLY place the IPC Dr/Cr mapping lives (PURE — turns an Ipc into a balanced
 * PostingCommand). It mirrors the LED/SAL design §4 worked template line-for-line and NEVER emits a
 * zero-value line, so an IPC with no advance/AIT simply has fewer lines while still balancing.
 *
 * The §4 SPLIT-AR form (the doc's chosen, test-locked form):
 *   1. Dr Accounts Receivable (control)     = certified + outputVat            [party]   (gross AR)
 *   2. Cr Revenue — Construction            = certified                        [dims]
 *   3. Cr Output VAT Payable (Mushak)        = outputVat                        [dims]
 *   4. Dr AIT Recoverable                    = aitTds                           [dims]
 *   4b. Cr Accounts Receivable (control)     = aitTds                           [party]   (AIT contra)
 *   5. Dr Retention Receivable               = retention                        [party]
 *   6. Cr Accounts Receivable (control)      = retention                        [party]   (retention contra)
 *   7. Dr Mobilization Advance (liability)   = advanceRecovered                 [party]
 *   8. Cr Accounts Receivable (control)      = advanceRecovered                 [party]   (advance contra)
 *
 * The gross AR (1) is contra-credited by AIT (4b), retention (6) and advance (8), so the NET AR carried
 * against the customer = currently-due = certified + VAT − AIT − retention − advance. Revenue/VAT/AIT
 * P&L lines carry project + cost_centre + purpose (no godown); the AR / Retention / Advance control lines
 * carry the customer party. Σdebit = Σcredit by construction (LED re-validates + the deferred DB trigger
 * backstops at commit). `accountType`/`isControlAccount` hints let LED's TagMatrix apply the §5.1 rules
 * without a lookup.
 */
import { Money } from '../../../common/money';
import { PostingCommand, PostingLine } from '../../../core/posting/domain/posting-command';
import { Ipc, IPC_SOURCE_TYPE } from './ipc';

/** The six resolved sales posting-account ids (MAS), injected per company (FR-SAL-010). */
export interface SalesAccountMap {
  accountsReceivable: string;
  retentionReceivable: string;
  mobilizationAdvance: string;
  aitRecoverable: string;
  revenueConstruction: string;
  outputVatPayable: string;
}

export function buildIpcCommand(ipc: Ipc, accounts: SalesAccountMap, postedBy: string): PostingCommand {
  const p = ipc.props;
  const dims = { projectId: p.projectId, costCentreId: p.costCentreId, purposeId: p.purposeId };
  const party = p.customerId;

  const certified = p.certifiedAmount.amount;
  const outputVat = p.outputVatAmount.amount;
  const aitTds = p.aitTdsAmount.amount;
  const retention = p.retentionAmount.amount;
  const advance = p.advanceRecoveredAmount.amount;

  // Gross AR debit (line 1) = certified + outputVat; the retention/advance contras (6/8) reduce it to net.
  const grossAr = certified.plus(outputVat);

  const lines: PostingLine[] = [];

  // 1. Dr Accounts Receivable (control) — gross, party-tagged. Always present (certified > 0).
  lines.push({
    accountId: accounts.accountsReceivable,
    ...dims,
    partyId: party,
    debit: Money.of(grossAr),
    credit: Money.zero(),
    accountType: 'ASSET',
    isControlAccount: true,
  });

  // 2. Cr Revenue — Construction — full certified (AIT never reduces revenue).
  lines.push({
    accountId: accounts.revenueConstruction,
    ...dims,
    debit: Money.zero(),
    credit: Money.of(certified),
    accountType: 'INCOME',
    isControlAccount: false,
  });

  // 3. Cr Output VAT Payable (Mushak) — omit when zero.
  if (outputVat.greaterThan(0)) {
    lines.push({
      accountId: accounts.outputVatPayable,
      ...dims,
      debit: Money.zero(),
      credit: Money.of(outputVat),
      accountType: 'LIABILITY',
      isControlAccount: false,
    });
  }

  // 4 + 4b. AIT Recoverable debit + AR contra credit — the AIT the customer withholds reduces the AR
  // they will pay (it never reduces revenue). Omit the pair when zero.
  if (aitTds.greaterThan(0)) {
    lines.push({
      accountId: accounts.aitRecoverable,
      ...dims,
      debit: Money.of(aitTds),
      credit: Money.zero(),
      accountType: 'ASSET',
      isControlAccount: false,
    });
    lines.push({
      accountId: accounts.accountsReceivable,
      ...dims,
      partyId: party,
      debit: Money.zero(),
      credit: Money.of(aitTds),
      accountType: 'ASSET',
      isControlAccount: true,
    });
  }

  // 5 + 6. Retention Receivable debit + AR contra credit — omit the pair when zero.
  if (retention.greaterThan(0)) {
    lines.push({
      accountId: accounts.retentionReceivable,
      ...dims,
      partyId: party,
      debit: Money.of(retention),
      credit: Money.zero(),
      accountType: 'ASSET',
      isControlAccount: true,
    });
    lines.push({
      accountId: accounts.accountsReceivable,
      ...dims,
      partyId: party,
      debit: Money.zero(),
      credit: Money.of(retention),
      accountType: 'ASSET',
      isControlAccount: true,
    });
  }

  // 7 + 8. Mobilization Advance debit + AR contra credit — omit the pair when zero.
  if (advance.greaterThan(0)) {
    lines.push({
      accountId: accounts.mobilizationAdvance,
      ...dims,
      partyId: party,
      debit: Money.of(advance),
      credit: Money.zero(),
      accountType: 'LIABILITY',
      isControlAccount: true,
    });
    lines.push({
      accountId: accounts.accountsReceivable,
      ...dims,
      partyId: party,
      debit: Money.zero(),
      credit: Money.of(advance),
      accountType: 'ASSET',
      isControlAccount: true,
    });
  }

  return {
    companyId: p.companyId,
    financialYearId: p.financialYearId,
    voucherType: 'SALES_IPC',
    voucherDate: p.ipcDate,
    sourceType: IPC_SOURCE_TYPE,
    sourceId: ipc.id,
    postedBy,
    narration: p.narration ?? undefined,
    lines,
  };
}
