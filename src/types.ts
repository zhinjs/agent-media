/** A media payload that was removed from a tool result. Bytes never travel past this point. */
export interface MediaBytes {
  readonly bytes: Uint8Array;
  readonly mime: string;
}

/**
 * Who may read a private asset. Hosts pass their own identity (session, user, conversation);
 * single-user CLIs can use a constant. Only its hash is stored.
 */
export type MediaScope = string;

/** A private, expiring reference. Never public; read back only within the same scope. */
export interface PrivateMediaRef {
  readonly asset_id: string;
  readonly mime: string;
  readonly size: number;
  readonly expires_at: number;
}

/** A public reference: anyone holding the URL can read it until storage cleanup. */
export interface PublicMediaRef {
  readonly url: string;
  readonly mime: string;
  readonly size: number;
}

export interface PrivateMediaStore {
  capture(media: MediaBytes, scope: MediaScope, source?: string, signal?: AbortSignal): Promise<PrivateMediaRef>;
  read(assetId: string, scope: MediaScope, signal?: AbortSignal): Promise<MediaBytes & { readonly ref: PrivateMediaRef }>;
}

export interface PublicMediaStore {
  publish(media: MediaBytes, signal?: AbortSignal): Promise<PublicMediaRef>;
  /** True only for URLs this store minted, e.g. to skip re-fetch checks. */
  ownsUrl(url: string): boolean;
}
