import { CONFIG } from '../config.js';
import { hasMojibakeNoise } from '../utils/text.js';
import type { ArchiveItem } from '../types.js';

function containsAnyKeyword(haystack: string, keywords: string[]): boolean {
  const h = haystack.toLowerCase();
  return keywords.some((k) => h.includes(k));
}

export function isAiRelated(record: ArchiveItem): boolean {
  const siteId = (record.site_id || '').toLowerCase();
  const title = record.title || '';
  const source = record.source || '';
  const siteName = record.site_name || '';
  const url = record.url || '';
  const text = `${title} ${source} ${siteName} ${url}`.toLowerCase();

  if (siteId === 'zeli') {
    return source.toLowerCase().includes('24h') || source.includes('24h最热');
  }

  if (siteId === 'tophub') {
    const sourceL = source.toLowerCase();
    if (hasMojibakeNoise(source) || hasMojibakeNoise(title)) {
      return false;
    }
    if (containsAnyKeyword(sourceL, CONFIG.filter.tophubBlockKeywords)) {
      return false;
    }
    if (!containsAnyKeyword(sourceL, CONFIG.filter.tophubAllowKeywords)) {
      return false;
    }
  }

  if (['aibase', 'aihot', 'aihubtoday'].includes(siteId)) {
    return true;
  }

  const hasAi =
    containsAnyKeyword(text, CONFIG.filter.aiKeywords) ||
    CONFIG.filter.enSignalPattern.test(text);
  const hasTech = containsAnyKeyword(text, CONFIG.filter.techKeywords);

  // ===== 素心拾穗扩展过滤 =====
  const hasCognition = containsAnyKeyword(text, CONFIG.filter.cognitionKeywords);
  const hasIp = containsAnyKeyword(text, CONFIG.filter.ipKeywords);
  const hasMonetize = containsAnyKeyword(text, CONFIG.filter.monetizeKeywords);
  const hasRural = containsAnyKeyword(text, CONFIG.filter.ruralKeywords);
  const isSuxinRelated = hasAi || hasTech || hasCognition || hasIp || hasMonetize || hasRural;

  if (!isSuxinRelated) {
    return false;
  }

  if (containsAnyKeyword(text, CONFIG.filter.commerceNoiseKeywords) && !hasAi && !hasCognition && !hasIp) {
    return false;
  }

  if (containsAnyKeyword(text, CONFIG.filter.noiseKeywords) && !hasAi && !hasCognition) {
    return false;
  }

  return true;
}

/**
 * 判断是否属于素心拾穗的认知成长/个人IP/变现/回乡方向
 * 用于在输出中分类标注
 */
export function getSuxinCategory(record: ArchiveItem): string[] {
  const title = record.title || '';
  const source = record.source || '';
  const text = `${title} ${source}`.toLowerCase();

  const categories: string[] = [];

  if (containsAnyKeyword(text, CONFIG.filter.aiKeywords) ||
      CONFIG.filter.enSignalPattern.test(text)) {
    categories.push('AI');
  }
  if (containsAnyKeyword(text, CONFIG.filter.cognitionKeywords)) {
    categories.push('认知');
  }
  if (containsAnyKeyword(text, CONFIG.filter.ipKeywords)) {
    categories.push('IP');
  }
  if (containsAnyKeyword(text, CONFIG.filter.monetizeKeywords)) {
    categories.push('变现');
  }
  if (containsAnyKeyword(text, CONFIG.filter.ruralKeywords)) {
    categories.push('回乡');
  }

  return categories.length > 0 ? categories : ['其他'];
}
