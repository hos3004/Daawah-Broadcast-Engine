const ARABIC_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const TATWEEL = /\u0640/g;
const ALEF_VARIANTS = /[\u0622\u0623\u0625\u0671]/g;
const DANGEROUS_PATH_CHARS = /[<>:"/\\|?*\u0000-\u001F]/g;

export interface SafeSlugOptions {
  fallback?: string;
  maxLength?: number;
}

export interface SafeNameInput {
  entityId?: string;
  originalName: string;
}

export interface SafeNameMappingPreview extends SafeNameInput {
  normalizedName: string;
  safeSlug: string;
  collisionGroup: string | null;
  collisionIndex: number;
}

export function normalizeArabicForMatch(value: string): string {
  return value
    .normalize('NFKC')
    .replace(ARABIC_DIACRITICS, '')
    .replace(TATWEEL, '')
    .replace(ALEF_VARIANTS, '\u0627')
    .replace(/\u0649/g, '\u064A')
    .replace(/\u0629/g, '\u0647')
    .replace(/[-\u2010-\u2015_.,;:،؛!?()[\]{}'"`~+*=|\\/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('ar');
}

export function generateSafeSlug(value: string, options: SafeSlugOptions = {}): string {
  const fallback = options.fallback ?? 'item';
  const maxLength = options.maxLength ?? 80;
  const normalized = normalizeArabicForMatch(value)
    .replace(DANGEROUS_PATH_CHARS, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const slug = normalized || fallback;
  return slug.slice(0, maxLength).replace(/-$/g, '') || fallback;
}

export function buildSafeNameMappings(items: SafeNameInput[]): SafeNameMappingPreview[] {
  const prepared = items.map(item => {
    const normalizedName = normalizeArabicForMatch(item.originalName);
    const baseSlug = generateSafeSlug(item.originalName);
    return { ...item, normalizedName, baseSlug };
  });

  const counts = new Map<string, number>();
  for (const item of prepared) {
    counts.set(item.baseSlug, (counts.get(item.baseSlug) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  return prepared.map(item => {
    const nextIndex = seen.get(item.baseSlug) ?? 0;
    seen.set(item.baseSlug, nextIndex + 1);

    const hasCollision = (counts.get(item.baseSlug) ?? 0) > 1;
    return {
      entityId: item.entityId,
      originalName: item.originalName,
      normalizedName: item.normalizedName,
      safeSlug: nextIndex === 0 ? item.baseSlug : `${item.baseSlug}-${nextIndex + 1}`,
      collisionGroup: hasCollision ? item.baseSlug : null,
      collisionIndex: nextIndex,
    };
  });
}

export function resolveSlugCollision(baseSlug: string, usedSlugs: Set<string>): string {
  if (!usedSlugs.has(baseSlug)) {
    usedSlugs.add(baseSlug);
    return baseSlug;
  }

  let index = 2;
  let candidate = `${baseSlug}-${index}`;
  while (usedSlugs.has(candidate)) {
    index++;
    candidate = `${baseSlug}-${index}`;
  }
  usedSlugs.add(candidate);
  return candidate;
}
