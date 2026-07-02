/**
 * PaymentAccountMapPort — driven port (MAS): resolve PAY's two well-known posting accounts for a company —
 * the labour cost account (CoA '5110', for the daily-labour true-up) and the bank charges account (CoA
 * '6200'). Throws PaymentAccountNotConfiguredError if either is absent.
 */
export interface PaymentAccountMapPort {
  resolve(companyId: string): Promise<{ labourCostAccountId: string; bankChargesAccountId: string }>;
}

export const PAYMENT_ACCOUNT_MAP_PORT = Symbol('PaymentAccountMapPort');
