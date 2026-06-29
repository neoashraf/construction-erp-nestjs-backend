/**
 * CompanyController (PRESENTATION) — `/api/masters/companies` (FR-MAS-001, FR-MAS-004). Thin: resolve
 * the actor, delegate to use cases (writes) / the query service (reads), map the result. The company
 * is taken from the actor, never the body. Auth/role guards (Admin for writes) are wired by the
 * `auth-jwt` brief (JwtAuthGuard + RolesGuard); until then `@CurrentActor` resolves the actor.
 */
import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { CurrentActor } from '../../presentation/current-actor.decorator';
import { CreateCompanyUseCase } from '../../application/company/create-company.use-case';
import { UpdateCompanyUseCase } from '../../application/company/update-company.use-case';
import { UpdateLocalizationUseCase } from '../../application/company/update-localization.use-case';
import { CompanyDto, CompanyQueryService } from '../read/company.query-service';
import { PaginatedResult } from '../../read/pagination';
import { CreateCompanyDto, UpdateCompanyDto, UpdateLocalizationDto } from './dto/company.dto';

@Controller('api/masters/companies')
export class CompanyController {
  constructor(
    private readonly createCompany: CreateCompanyUseCase,
    private readonly updateCompany: UpdateCompanyUseCase,
    private readonly updateLocalization: UpdateLocalizationUseCase,
    private readonly query: CompanyQueryService,
  ) {}

  @Get()
  list(@CurrentActor() actor: Actor): Promise<PaginatedResult<CompanyDto>> {
    return this.query.list(actor);
  }

  @Get(':id')
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<CompanyDto> {
    const dto = await this.query.getById(id, actor);
    if (!dto) throw new NotFoundException(`Company ${id} not found`);
    return dto;
  }

  @Post()
  create(@Body() body: CreateCompanyDto, @CurrentActor() actor: Actor): Promise<{ id: string }> {
    return this.createCompany.execute(
      {
        name: body.name,
        legalName: body.legal_name,
        bin: body.bin,
        tin: body.tin,
        address: body.address,
        currency: body.currency,
        dateFormat: body.date_format,
        locale: body.locale,
      },
      actor,
    );
  }

  @Patch(':id')
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCompanyDto,
    @CurrentActor() actor: Actor,
  ): Promise<CompanyDto> {
    await this.updateCompany.execute(
      id,
      {
        name: body.name,
        legalName: body.legal_name,
        bin: body.bin,
        tin: body.tin,
        address: body.address,
      },
      body.version,
      actor,
    );
    return this.requireById(id, actor);
  }

  @Put(':id/localization')
  async putLocalization(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateLocalizationDto,
    @CurrentActor() actor: Actor,
  ): Promise<CompanyDto> {
    await this.updateLocalization.execute(
      id,
      { currency: body.currency, dateFormat: body.date_format, locale: body.locale },
      body.version,
      actor,
    );
    return this.requireById(id, actor);
  }

  private async requireById(id: string, actor: Actor): Promise<CompanyDto> {
    const dto = await this.query.getById(id, actor);
    if (!dto) throw new NotFoundException(`Company ${id} not found`);
    return dto;
  }
}
