/** Metadata for a file attached to a booking. The bytes live on disk. */
export interface Attachment {
  id: string;
  bookingId: string;
  /** Original filename as supplied by the uploader. */
  filename: string;
  contentType: string;
  size: number;
  /** Hex SHA-1 of the content, used for de-duplication and ETags. */
  checksum: string;
  uploadedAt: string;
  /** Key id of whoever uploaded it. */
  uploadedBy: string;
}

export interface UploadAttachmentInput {
  bookingId: string;
  filename: string;
  contentType?: string;
  bytes: Buffer;
}

/** Raised for invalid uploads or missing files (HTTP 400 / 404). */
export class AttachmentError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 413 = 400,
  ) {
    super(message);
    this.name = "AttachmentError";
  }
}
