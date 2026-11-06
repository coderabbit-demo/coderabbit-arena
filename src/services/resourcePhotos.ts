import { BookingStore } from "../store/store";
import { NotFoundError } from "./bookingService";

/** A stored resource photo, kept in memory alongside its content type. */
export interface ResourcePhoto {
  resourceId: string;
  contentType: string;
  bytes: Buffer;
}

/** Minimal fetch surface so tests can supply their own implementation. */
export type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export class ResourcePhotoError extends Error {
  constructor(message: string, public readonly status: 400 | 404 = 400) {
    super(message);
    this.name = "ResourcePhotoError";
  }
}

/**
 * Fetches and serves a photo for a resource. Admins point this at a URL (a
 * floor-plan, a product shot) and the server downloads it once and caches the
 * bytes so the image survives the source going away.
 */
export class ResourcePhotoService {
  private readonly photos = new Map<string, ResourcePhoto>();

  constructor(
    private readonly store: BookingStore,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  /** Download the image at `url` and store it against the resource. */
  async setFromUrl(resourceId: string, url: string): Promise<ResourcePhoto> {
    if (!this.store.getResource(resourceId)) {
      throw new ResourcePhotoError(`Resource not found: ${resourceId}`, 404);
    }
    if (typeof url !== "string" || url.length === 0) {
      throw new ResourcePhotoError("url is required");
    }
    const res = await this.fetchImpl(url);
    if (!res.ok) {
      throw new ResourcePhotoError(`Fetching ${url} failed with status ${res.status}`);
    }
    const photo: ResourcePhoto = {
      resourceId,
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
      bytes: Buffer.from(await res.arrayBuffer()),
    };
    this.photos.set(resourceId, photo);
    return photo;
  }

  /** Return the stored photo for a resource. */
  get(resourceId: string): ResourcePhoto {
    const photo = this.photos.get(resourceId);
    if (!photo) {
      throw new NotFoundError(`No photo for resource: ${resourceId}`);
    }
    return photo;
  }
}
