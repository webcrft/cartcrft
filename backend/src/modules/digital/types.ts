/**
 * digital/types.ts — TypeScript types for digital product delivery.
 */

export interface DigitalDownloadLink {
  id: string;
  store_id: string;
  order_id: string;
  order_line_id: string | null;
  file_id: string;
  customer_id: string | null;
  token: string;
  download_count: number;
  max_downloads: number | null;
  expires_at: Date | null;
  last_downloaded_at: Date | null;
  created_at: Date;
  file_name?: string;
}

export interface GenerateDownloadLinksInput {
  max_downloads?: number | null | undefined;
  expires_at?: string | null | undefined;
}

export interface DownloadTokenInfo {
  file_url: string;
  file_name: string;
  order_id: string;
  download_count: number;
  max_downloads: number | null;
  expires_at: Date | null;
}
