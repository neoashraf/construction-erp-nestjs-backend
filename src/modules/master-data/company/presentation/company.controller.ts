/**
 * CompanyController (PRESENTATION) — `/api/masters/companies` (FR-MAS-001, FR-MAS-004). Thin: resolve
 * the actor, delegate to use cases (writes) / the query service (reads), map the result. The company
 * is taken from the actor, never the body. `@UseGuards(JwtAuthGuard, RolesGuard)` + per-route
 * `@Roles({module:'MAS', action})` (mas-rbac-guard-wiring, FR-AUD-012/013).
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
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { CurrentActor } from '../../../../core/auth/presentation/current-actor.decorator';
import { JwtAuthGuard } from '../../../../core/auth/presentation/jwt-auth.guard';
import { RolesGuard } from '../../../../core/auth/presentation/roles.guard';
import { Roles } from '../../../../core/auth/presentation/roles.decorator';
import { CreateCompanyUseCase } from '../../application/company/create-company.use-case';
import { UpdateCompanyUseCase } from '../../application/company/update-company.use-case';
import { UpdateLocalizationUseCase } from '../../application/company/update-localization.use-case';
import { CompanyDto, CompanyQueryService } from '../read/company.query-service';
import { Paginated } from '../../../../infrastructure/http/pagination';
import { CreateCompanyDto, UpdateCompanyDto, UpdateLocalizationDto } from './dto/company.dto';

@ApiTags('Org')
@Controller('api/masters/companies')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CompanyController {
  constructor(
    private readonly createCompany: CreateCompanyUseCase,
    private readonly updateCompany: UpdateCompanyUseCase,
    private readonly updateLocalization: UpdateLocalizationUseCase,
    private readonly query: CompanyQueryService,
  ) {}

  @Get()
  @Roles({ module: 'MAS', action: 'READ' })
  list(@CurrentActor() actor: Actor): Promise<Paginated<CompanyDto>> {
    return this.query.list(actor);
  }

  @Get(':id')
  @Roles({ module: 'MAS', action: 'READ' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<CompanyDto> {
    const dto = await this.query.getById(id, actor);
    if (!dto) throw new NotFoundException(`Company ${id} not found`);
    return dto;
  }

  @Post()
  @Roles({ module: 'MAS', action: 'CREATE' })
  create(@Body() body: CreateCompanyDto, @CurrentActor() actor: Actor): Promise<{ id: string }> {
    return this.createCompany.execute(
      {
        name: body.name,
        legalName: body.legalName,
        bin: body.bin,
        tin: body.tin,
        address: body.address,
        currency: body.currency,
        dateFormat: body.dateFormat,
        locale: body.locale,
      },
      actor,
    );
  }

  @Patch(':id')
  @Roles({ module: 'MAS', action: 'UPDATE' })
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCompanyDto,
    @CurrentActor() actor: Actor,
  ): Promise<CompanyDto> {
    const { version, ...changes } = body;
    await this.updateCompany.execute(id, changes, version, actor);
    return this.requireById(id, actor);
  }

  @Put(':id/localization')
  @Roles({ module: 'MAS', action: 'UPDATE' })
  async putLocalization(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateLocalizationDto,
    @CurrentActor() actor: Actor,
  ): Promise<CompanyDto> {
    const { version, ...changes } = body;
    await this.updateLocalization.execute(id, changes, version, actor);
    return this.requireById(id, actor);
  }

  private async requireById(id: string, actor: Actor): Promise<CompanyDto> {
    const dto = await this.query.getById(id, actor);
    if (!dto) throw new NotFoundException(`Company ${id} not found`);
    return dto;
  }
}
