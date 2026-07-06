/**
 * NotificationsController (NTF PRESENTATION) — `/api/notifications`. The bell's REST feed, self-scoped to
 * the token's user (no `:id` for another user), guarded (`JwtAuthGuard`, `RolesGuard`) — open to any
 * authenticated active user, no permission gate. There is NO create/update/delete: a client cannot author
 * a notification (that's the internal `NotificationService.emit` seam). FR-NTF-003/004/005/013/014/015.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { JwtAuthGuard } from '../../auth/presentation/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/roles.guard';
import { CurrentActor } from '../../auth/presentation/current-actor.decorator';
import { Actor } from '../../tenancy/tenant-context';
import { NotificationsQueryService } from '../read/notifications.query-service';
import { NotificationService } from '../application/notification.service';

class ReadAllDto {
  @IsOptional() @IsString() type?: string;
}

@ApiTags('Notifications')
@ApiBearerAuth('access-token')
@Controller('api/notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
export class NotificationsController {
  constructor(
    private readonly query: NotificationsQueryService,
    private readonly service: NotificationService,
  ) {}

  @Get()
  list(
    @CurrentActor() actor: Actor,
    @Query('isRead') isRead?: string,
    @Query('type') type?: string,
    @Query('since') since?: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '25',
  ) {
    return this.query.list(actor, {
      isRead: isRead === undefined ? undefined : isRead === 'true',
      type,
      since,
      page: +page,
      pageSize: +pageSize,
    });
  }

  @Get('unread-count')
  async unreadCount(@CurrentActor() actor: Actor) {
    return { unreadCount: await this.query.unreadCount(actor) };
  }

  @Get(':id')
  async findById(@Param('id') id: string, @CurrentActor() actor: Actor) {
    const view = await this.query.getForRecipient(actor, id);
    if (!view) throw new NotFoundException('Notification not found');
    return view;
  }

  @Post(':id/read')
  read(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.service.markOneRead(actor, id);
  }

  @Post('read-all')
  @HttpCode(200)
  readAll(@Body() dto: ReadAllDto, @CurrentActor() actor: Actor) {
    return this.service.markAllRead(actor, dto.type);
  }
}
