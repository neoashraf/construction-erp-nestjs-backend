/**
 * Company request DTOs (PRESENTATION). Wire JSON is snake_case per the platform API convention
 * (api-contracts/01-master-data.md); the internal domain stays camelCase, mapped in the controller.
 * class-validator does shape/type checks; the domain VOs (`Bin`/`Tin`) do format validation.
 * `company_id` is NEVER a body field — the company comes from the actor (FR-MAS-001).
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
  legal_name!: string;

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
  date_format?: string;

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
  legal_name?: string;

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
  date_format!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(20)
  locale!: string;

  @IsInt()
  @Min(1)
  version!: number;
}
