import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AUD profile self-service — avatar columns on `user` (FR-AUD-038..043).
 *
 * A NEW migration on top of the shipped 1700000700000 (user) — never edits it. Adds two nullable
 * columns for the profile photo: `avatar_url` (the served Cloudinary URL, returned to clients) and
 * `avatar_public_id` (the Cloudinary asset handle used to replace/delete, never returned). No index —
 * the avatar is read only as part of the caller's own profile row (already fetched by id).
 */
export class AddUserAvatar1700002400000 implements MigrationInterface {
  name = 'AddUserAvatar1700002400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "avatar_url" varchar;`);
    await queryRunner.query(`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "avatar_public_id" varchar;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN IF EXISTS "avatar_public_id";`);
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN IF EXISTS "avatar_url";`);
  }
}
