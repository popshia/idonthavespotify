import {
  RESPONSE_COMPARE_MIN_INCLUSION_SCORE,
  RESPONSE_COMPARE_MIN_SCORE,
} from '~/config/constants';
import { Adapter, MetadataType, Parser } from '~/config/enum';
import { ENV } from '~/config/env';
import { cacheSearchResultLink, getCachedSearchResultLink } from '~/services/cache';
import type { SearchMetadata, SearchResultLink } from '~/services/search';
import { scoreMatch } from '~/utils/compare';
import HttpClient from '~/utils/http-client';
import { logger } from '~/utils/logger';
import { getCheerioDoc } from '~/utils/scraper';
import { getServiceGuard } from '~/utils/service-guard';

// Result links by shape, not by shelf label: shelf labels ("Songs") are
// localized, and a song row also links its artist, which used to win the
// score for titles Apple translates (沙發 -> "Drown in Sofa" on us).
const APPLE_MUSIC_SEARCH_TYPES = {
  [MetadataType.Song]: 'a[href*="?i="]',
  [MetadataType.Album]: 'a[href*="/album/"]:not([href*="?i="])',
  [MetadataType.Playlist]: 'a[href*="/playlist/"]',
  [MetadataType.Artist]: 'a[href*="/artist/"]',
  [MetadataType.Podcast]: undefined,
  [MetadataType.Show]: undefined,
};

// Top-result links carry "<title> · <type> · <artist>" (U+2004 around the
// dot); scoring title plus artist matches a query that names the artist.
const resultText = (label: string | undefined, text: string) => {
  const parts = label?.split(/\s·\s/);
  return parts && parts.length > 2 ? `${parts[0]} ${parts.at(-1)}` : text;
};

export async function getAppleMusicLink(
  query: string,
  metadata: SearchMetadata,
  sourceParser: Parser,
  sourceId: string
) {
  const searchType = APPLE_MUSIC_SEARCH_TYPES[metadata.type];
  if (!searchType) return null;

  // x-www-form-urlencoded encoding required for browser url
  const params = `term=${encodeURIComponent(query)}`;

  const url = new URL(`${ENV.adapters.appleMusic.apiUrl}/search?${params}`);

  const cache = await getCachedSearchResultLink(
    Adapter.AppleMusic,
    sourceParser,
    sourceId
  );
  if (cache) {
    logger.info(`[Apple Music] (${url}) cache hit`);
    return cache;
  }

  const guard = getServiceGuard('appleMusic');
  if (!guard.acquire()) {
    logger.warn('[Apple Music] service guard: request blocked');
    return null;
  }

  try {
    const html = await HttpClient.get<string>(url.toString());
    guard.recordSuccess();
    const doc = getCheerioDoc(html);

    const candidates = doc(`${searchType}[href^="https://music.apple.com/"]`)
      .map((_, el) => ({
        href: doc(el).attr('href') ?? '',
        text: resultText(doc(el).attr('aria-label'), doc(el).text().trim()),
      }))
      .get()
      .filter(candidate => candidate.text)
      .slice(0, 3);

    const { href, score } = candidates.reduce(
      (best, candidate) => {
        const candidateScore = scoreMatch(candidate.text, query);
        return candidateScore > best.score
          ? { href: candidate.href, score: candidateScore }
          : best;
      },
      { href: '', score: 0 }
    );
    if (!href) throw new Error(`Result with best score not found for: ${query}`);

    // Convert music.apple.com links to geo.music.apple.com links for better results
    const geoUrl = href.replace('music.apple.com', 'geo.music.apple.com');

    if (href !== geoUrl) {
      logger.info(`[Apple Music] transformed to geo link: ${geoUrl}`);
    }

    const searchResultLink = {
      type: Adapter.AppleMusic,
      url: geoUrl,
      isVerified: score >= RESPONSE_COMPARE_MIN_SCORE,
      notAvailable: score < RESPONSE_COMPARE_MIN_INCLUSION_SCORE,
    } as SearchResultLink;

    logger.info(
      `[Apple Music] Result score: ${score.toFixed(3)} (verified: ${searchResultLink.isVerified ? 'yes' : 'no'}, available: ${!searchResultLink.notAvailable ? 'yes' : 'no'})`
    );

    await cacheSearchResultLink(
      Adapter.AppleMusic,
      sourceParser,
      sourceId,
      searchResultLink
    );

    return searchResultLink;
  } catch (err) {
    guard.recordFailure();
    logger.error(`[Apple Music] (${url}) ${err} `);
    return null;
  }
}
