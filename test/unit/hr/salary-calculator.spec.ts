/**
 * SalaryCalculator domain unit tests (no DB, no Nest). 100% coverage target (brief DoD): calcGross for
 * MONTHLY (pro-rated by paid days) and DAILY (rate × attended days), overtime on both wage types,
 * applyComponents' net formula (net = gross + allowances − deductions), and exact decimal (no float
 * drift). Cites FR-HR-013/-014.
 */
import { Money } from '../../../src/common/money';
import { ValidationError } from '../../../src/common/errors/domain-error';
import { applyComponents, calcGross } from '../../../src/modules/hr/domain/salary-calculator';

describe('calcGross — MONTHLY (pro-rated by paid days)', () => {
  it('prorates the monthly salary by paidDays/standardDays', () => {
    const gross = calcGross(
      { wageType: 'MONTHLY', wageAmount: Money.of('45000') },
      { paidDays: '30', standardDays: '30', attendedDays: '30' },
    );
    expect(gross.toFixed()).toBe('45000.0000');
  });

  it('prorates a partial month exactly (decimal, no float drift)', () => {
    // 45000 * (22/30) = 33000.0000 exactly
    const gross = calcGross(
      { wageType: 'MONTHLY', wageAmount: Money.of('45000') },
      { paidDays: '22', standardDays: '30', attendedDays: '22' },
    );
    expect(gross.toFixed()).toBe('33000.0000');
  });

  it('adds overtime on top of the prorated MONTHLY gross', () => {
    const gross = calcGross(
      { wageType: 'MONTHLY', wageAmount: Money.of('45000') },
      { paidDays: '30', standardDays: '30', attendedDays: '30', overtimeAmount: '1500.5' },
    );
    expect(gross.toFixed()).toBe('46500.5000');
  });

  it('rejects standardDays <= 0', () => {
    expect(() =>
      calcGross(
        { wageType: 'MONTHLY', wageAmount: Money.of('45000') },
        { paidDays: '10', standardDays: '0', attendedDays: '10' },
      ),
    ).toThrow(ValidationError);
  });

  it('rejects negative paidDays', () => {
    expect(() =>
      calcGross(
        { wageType: 'MONTHLY', wageAmount: Money.of('45000') },
        { paidDays: '-1', standardDays: '30', attendedDays: '0' },
      ),
    ).toThrow(ValidationError);
  });

  it('rejects negative overtimeAmount', () => {
    expect(() =>
      calcGross(
        { wageType: 'MONTHLY', wageAmount: Money.of('45000') },
        { paidDays: '30', standardDays: '30', attendedDays: '30', overtimeAmount: '-5' },
      ),
    ).toThrow(ValidationError);
  });
});

describe('calcGross — DAILY (rate × attended days)', () => {
  it('multiplies dailyRate by attendedDays exactly', () => {
    const gross = calcGross(
      { wageType: 'DAILY', wageAmount: Money.of('650') },
      { paidDays: '20', standardDays: '30', attendedDays: '20' },
    );
    expect(gross.toFixed()).toBe('13000.0000');
  });

  it('adds overtime on top of the DAILY gross', () => {
    const gross = calcGross(
      { wageType: 'DAILY', wageAmount: Money.of('650') },
      { paidDays: '20', standardDays: '30', attendedDays: '20', overtimeAmount: '325.25' },
    );
    expect(gross.toFixed()).toBe('13325.2500');
  });

  it('rejects negative attendedDays', () => {
    expect(() =>
      calcGross(
        { wageType: 'DAILY', wageAmount: Money.of('650') },
        { paidDays: '0', standardDays: '30', attendedDays: '-2' },
      ),
    ).toThrow(ValidationError);
  });

  it('zero attendedDays yields zero gross (no error)', () => {
    const gross = calcGross(
      { wageType: 'DAILY', wageAmount: Money.of('650') },
      { paidDays: '0', standardDays: '30', attendedDays: '0' },
    );
    expect(gross.toFixed()).toBe('0.0000');
  });
});

describe('calcGross — invalid wageType', () => {
  it('rejects a wageType that is neither MONTHLY nor DAILY', () => {
    expect(() =>
      calcGross(
        { wageType: 'HOURLY' as never, wageAmount: Money.of('100') },
        { paidDays: '1', standardDays: '30', attendedDays: '1' },
      ),
    ).toThrow(ValidationError);
  });
});

describe('applyComponents — net = gross + allowances − deductions', () => {
  it('computes the design §4(b) worked figures exactly for one employee scaled down', () => {
    // A scaled single-line check of the worked template's arithmetic shape (full multi-employee check
    // lives in salary-command.factory.spec.ts): gross 500,000, tds 40,000, pf 25,000, advance 30,000.
    const amounts = applyComponents(Money.of('500000'), {
      tds: '40000',
      pf: '25000',
      advanceRecovery: '30000',
    });
    expect(amounts.gross.toFixed()).toBe('500000.0000');
    expect(amounts.tds.toFixed()).toBe('40000.0000');
    expect(amounts.pf.toFixed()).toBe('25000.0000');
    expect(amounts.advanceRecovery.toFixed()).toBe('30000.0000');
    expect(amounts.allowances.toFixed()).toBe('0.0000');
    expect(amounts.other.toFixed()).toBe('0.0000');
    // net = 500,000 + 0 - (40,000+25,000+30,000+0) = 405,000
    expect(amounts.net.toFixed()).toBe('405000.0000');
  });

  it('adds allowances into net', () => {
    const amounts = applyComponents(Money.of('30000'), { allowances: '2500', tds: '1000' });
    expect(amounts.net.toFixed()).toBe('31500.0000'); // 30000 + 2500 - 1000
  });

  it('defaults every component to zero when omitted', () => {
    const amounts = applyComponents(Money.of('10000'), {});
    expect(amounts.allowances.toFixed()).toBe('0.0000');
    expect(amounts.tds.toFixed()).toBe('0.0000');
    expect(amounts.pf.toFixed()).toBe('0.0000');
    expect(amounts.advanceRecovery.toFixed()).toBe('0.0000');
    expect(amounts.other.toFixed()).toBe('0.0000');
    expect(amounts.net.toFixed()).toBe('10000.0000');
  });

  it('rejects a negative component', () => {
    expect(() => applyComponents(Money.of('10000'), { tds: '-1' })).toThrow(ValidationError);
    expect(() => applyComponents(Money.of('10000'), { pf: '-1' })).toThrow(ValidationError);
    expect(() => applyComponents(Money.of('10000'), { advanceRecovery: '-1' })).toThrow(ValidationError);
    expect(() => applyComponents(Money.of('10000'), { allowances: '-1' })).toThrow(ValidationError);
    expect(() => applyComponents(Money.of('10000'), { other: '-1' })).toThrow(ValidationError);
  });

  it('allows net to go negative when deductions exceed gross+allowances (arithmetic only — no floor)', () => {
    const amounts = applyComponents(Money.of('1000'), { tds: '900', pf: '900' });
    expect(amounts.net.toFixed()).toBe('-800.0000');
  });

  it('rounds a fractional gross/component to 4dp exactly (no float drift)', () => {
    const amounts = applyComponents(Money.of('10000.12345'), { allowances: '100.99995' });
    expect(amounts.gross.toFixed()).toBe('10000.1235'); // half-up at 4dp (…2345 -> …235)
    expect(amounts.allowances.toFixed()).toBe('101.0000'); // …99995 -> 101.0000 half-up
  });
});

// ── the late penalty (FR-HR-013a, FR-HR-008c) ────────────────────────────────────────────────────

describe('calcGross — late penalty', () => {
  it('reduces MONTHLY gross by the penalty days, exact to 4dp', () => {
    // 31,000 × (31 − 2) / 31. Computed in decimal.js: a float would drift here.
    const gross = calcGross(
      { wageType: 'MONTHLY', wageAmount: Money.of('31000') },
      { paidDays: '31', standardDays: '31', attendedDays: '26', penaltyDays: '2' },
    );

    expect(gross.toFixed()).toBe('29000.0000');
  });

  it('pays the full month when there is no penalty — the corrected baseline', () => {
    // The defect this brief fixes: this used to be 26/31 ≈ 84% for someone present every working day.
    const gross = calcGross(
      { wageType: 'MONTHLY', wageAmount: Money.of('31000') },
      { paidDays: '31', standardDays: '31', attendedDays: '26', penaltyDays: '0' },
    );

    expect(gross.toFixed()).toBe('31000.0000');
  });

  it('treats an omitted penaltyDays as zero, so an older caller is unaffected', () => {
    const gross = calcGross(
      { wageType: 'MONTHLY', wageAmount: Money.of('31000') },
      { paidDays: '31', standardDays: '31', attendedDays: '26' },
    );

    expect(gross.toFixed()).toBe('31000.0000');
  });

  it('never applies a late penalty to a DAILY-wage employee', () => {
    // FR-HR-013a's final clause: the holiday baseline and the penalty are MONTHLY-only.
    const gross = calcGross(
      { wageType: 'DAILY', wageAmount: Money.of('800') },
      { paidDays: '31', standardDays: '31', attendedDays: '20', penaltyDays: '5' },
    );

    expect(gross.toFixed()).toBe('16000.0000');
  });

  it('floors gross at zero rather than paying a negative salary', () => {
    const gross = calcGross(
      { wageType: 'MONTHLY', wageAmount: Money.of('31000') },
      { paidDays: '2', standardDays: '31', attendedDays: '2', penaltyDays: '9' },
    );

    expect(gross.toFixed()).toBe('0.0000');
  });

  it('rejects a negative penaltyDays', () => {
    expect(() =>
      calcGross(
        { wageType: 'MONTHLY', wageAmount: Money.of('31000') },
        { paidDays: '31', standardDays: '31', attendedDays: '26', penaltyDays: '-1' },
      ),
    ).toThrow(/penaltyDays must be >= 0/);
  });
});
