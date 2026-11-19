import {
  toPublicLink,
  type LinkRecord,
  type PublicLink,
} from '../../domain/links/types.js';

export function buildShortUrl(baseUrl: string, alias: string): string {
  return `${baseUrl}/${encodeURIComponent(alias)}`;
}

export type LinkResponse = PublicLink & { shortUrl: string };

export function toLinkResponse(
  link: LinkRecord,
  baseUrl: string,
): LinkResponse {
  return {
    ...toPublicLink(link),
    shortUrl: buildShortUrl(baseUrl, link.alias),
  };
}
