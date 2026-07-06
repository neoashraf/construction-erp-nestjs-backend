/**
 * NotificationsGateway (NTF PRESENTATION) — the `/ws/notifications` socket.io channel + the
 * NotificationPusher adapter (FR-NTF-007/008/009/010). Push-only: clients never mutate over the socket
 * (reads/marks go through REST). The handshake authenticates with the JWT access token; each socket is
 * scoped to its own `user:{companyId}:{userId}` room, so a push reaches only its recipient — no
 * cross-user / cross-company delivery. Delivery is best-effort; the REST feed is authoritative.
 */
import { Inject } from '@nestjs/common';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { TokenSigner, TOKEN_SIGNER } from '../../auth/domain/ports/token-signer.port';
import { NotificationRepository, NOTIFICATION_REPOSITORY } from '../domain/ports/notification.repository.port';
import { NotificationPusher } from '../domain/ports/notification-pusher.port';
import { NotificationView } from '../read/dto/notification-view.dto';

/** The per-recipient room — company + user scoped (FR-NTF-009). */
export function roomFor(companyId: string, userId: string): string {
  return `user:${companyId}:${userId}`;
}

@WebSocketGateway({ namespace: '/ws/notifications', cors: { origin: true } })
export class NotificationsGateway implements OnGatewayConnection, NotificationPusher {
  @WebSocketServer() server!: Server;

  constructor(
    @Inject(TOKEN_SIGNER) private readonly signer: TokenSigner,
    @Inject(NOTIFICATION_REPOSITORY) private readonly repo: NotificationRepository,
  ) {}

  /** JWT handshake: verify the access token, join the caller's room, seed the unread count. */
  async handleConnection(client: Socket): Promise<void> {
    const token = extractToken(client);
    if (!token) return this.reject(client);
    let claims;
    try {
      claims = this.signer.verifyAccess(token);
    } catch {
      return this.reject(client);
    }
    const room = roomFor(claims.companyId, claims.sub);
    client.join(room);
    try {
      const unreadCount = await this.repo.unreadCount(claims.companyId, claims.sub);
      client.emit('connected', { unreadCount });
    } catch {
      client.emit('connected', { unreadCount: 0 });
    }
  }

  private reject(client: Socket): void {
    client.emit('connect_error', { code: 'UNAUTHENTICATED' });
    client.disconnect(true);
  }

  // ── NotificationPusher (best-effort — never throws to the caller) ──
  async pushNew(userId: string, companyId: string, notification: NotificationView): Promise<void> {
    this.server?.to(roomFor(companyId, userId)).emit('notification:new', notification);
  }

  async pushUnreadCount(userId: string, companyId: string, unreadCount: number): Promise<void> {
    this.server?.to(roomFor(companyId, userId)).emit('notification:unreadCount', { unreadCount });
  }
}

/** Access token from the socket.io handshake `auth.token` or an `Authorization: Bearer` header. */
function extractToken(client: Socket): string | null {
  const auth = client.handshake?.auth as { token?: string } | undefined;
  if (auth?.token) return auth.token;
  const header = client.handshake?.headers?.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}
