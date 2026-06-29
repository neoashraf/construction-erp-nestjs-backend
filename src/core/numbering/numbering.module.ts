/**
 * Numbering kernel module (NUM) — EMPTY-BUT-WIRED.
 *
 * The gapless, transaction-safe voucher counter lands here in the `numbering-service` brief
 * (per company + financial year + voucher type, `SELECT … FOR UPDATE` inside the post tx, strictly
 * gapless for Mushak VAT). No business logic ships in the scaffold.
 */
import { Module } from '@nestjs/common';

@Module({})
export class NumberingModule {}
