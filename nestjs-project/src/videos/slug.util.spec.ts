import { generateVideoSlug } from './slug.util';

describe('generateVideoSlug', () => {
  it('should return 11 base62 characters', () => {
    expect(generateVideoSlug()).toMatch(/^[0-9A-Za-z]{11}$/);
  });

  it('should not repeat across many draws', () => {
    const draws = Array.from({ length: 10_000 }, () => generateVideoSlug());

    expect(new Set(draws).size).toBe(draws.length);
  });

  it('should use the whole base62 alphabet', () => {
    const seen = new Set(
      Array.from({ length: 2_000 }, () => generateVideoSlug()).join(''),
    );

    expect(seen.size).toBe(62);
  });
});
