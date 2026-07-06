/**
 * CloudinaryMediaStorage (INFRASTRUCTURE) — the MediaStorage adapter backing the profile avatar
 * (AUD profile slice, FR-AUD-038/040/041/043). The Cloudinary SDK is confined to this file; the
 * domain/application depend only on the `MediaStorage` port. Credentials come from config (never code);
 * the binary is uploaded and only the returned URL + public_id are handed back for persistence.
 *
 * Configured lazily: the app boots without Cloudinary env (dev/test/CI); an actual upload/delete while
 * unconfigured throws MEDIA_STORAGE_ERROR (503) rather than crashing boot.
 */
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryConfig } from '../../../config/app-config';
import { MediaStorage, MediaUploadInput, MediaUploadResult } from '../../../common/ports/driven-ports';

const MEDIA_STORAGE_ERROR = 'MEDIA_STORAGE_ERROR';

@Injectable()
export class CloudinaryMediaStorage implements MediaStorage {
  private configured = false;

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  /** Apply credentials on first use; throw a 503 (not a boot crash) if they're absent. */
  private ensureConfigured(): void {
    if (this.configured) return;
    const c = this.config.get<CloudinaryConfig>('cloudinary');
    if (!c || !c.cloudName || !c.apiKey || !c.apiSecret) {
      throw new ServiceUnavailableException(MEDIA_STORAGE_ERROR);
    }
    cloudinary.config({ cloud_name: c.cloudName, api_key: c.apiKey, api_secret: c.apiSecret, secure: true });
    this.configured = true;
  }

  async upload(input: MediaUploadInput): Promise<MediaUploadResult> {
    this.ensureConfigured();
    const dataUri = `data:${input.mimeType};base64,${input.buffer.toString('base64')}`;
    try {
      const res = await cloudinary.uploader.upload(dataUri, {
        folder: input.folder,
        public_id: input.publicId,
        overwrite: true,
        invalidate: true,
        resource_type: 'image',
      });
      return { url: res.secure_url, publicId: res.public_id };
    } catch {
      throw new ServiceUnavailableException(MEDIA_STORAGE_ERROR);
    }
  }

  async delete(publicId: string): Promise<void> {
    this.ensureConfigured();
    try {
      await cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true });
    } catch {
      throw new ServiceUnavailableException(MEDIA_STORAGE_ERROR);
    }
  }
}
