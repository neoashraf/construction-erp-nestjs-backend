/**
 * Company request DTOs (PRESENTATION). Wire JSON is camelCase per the platform API convention
 * (overview §6; api-contracts/01-master-data.md). class-validator does shape/type checks; the domain
 * VOs (`Bin`/`Tin`) do format validation. `companyId` is NEVER a body field — the company comes from
 * the actor (FR-MAS-001).
 */
import { IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class CreateCompanyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  legalName!: string;

  @IsString()
  bin!: string;

  @IsString()
  tin!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  dateFormat?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  locale?: string;
}

export class UpdateCompanyDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  legalName?: string;

  @IsOptional()
  @IsString()
  bin?: string;

  @IsOptional()
  @IsString()
  tin?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  address?: string | null;

  @IsInt()
  @Min(1)
  version!: number;
}

export class UpdateLocalizationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(8)
  currency!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(20)
  dateFormat!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(20)
  locale!: string;

  @IsInt()
  @Min(1)
  version!: number;
}
