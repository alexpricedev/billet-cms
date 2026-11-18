import { describe, expect, test } from "bun:test";
import { MAX_ALT_LENGTH } from "../contract";
import type { VideoValue } from "../fields/video";
import { renderCmsVideo } from "./video";

const youtube: VideoValue = {
  provider: "youtube",
  id: "dQw4w9WgXcQ",
  title: "A talk about foxes",
};

const vimeo: VideoValue = {
  provider: "vimeo",
  id: "76979871",
  title: "A walk through the woods",
};

describe("renderCmsVideo", () => {
  test("renders a YouTube player through youtube-nocookie.com", () => {
    const html = renderCmsVideo(youtube);
    expect(html).toBe(
      '<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" title="A talk about foxes" loading="lazy" allowfullscreen style="aspect-ratio:16/9;width:100%;border:0"></iframe>',
    );
    expect(html).not.toContain("youtube.com/watch");
  });

  test("renders a Vimeo player with dnt=1", () => {
    const html = renderCmsVideo(vimeo);
    expect(html).toContain(
      'src="https://player.vimeo.com/video/76979871?dnt=1"',
    );
    expect(html).toContain('title="A walk through the woods"');
  });

  test("carries the accessible name in title, escaped", () => {
    const html = renderCmsVideo({
      ...youtube,
      title: '" onload="alert(1)',
    });
    expect(html).not.toContain('onload="alert(1)"');
    expect(html).toContain("&quot; onload=&quot;alert(1)");
  });

  test("trims the title", () => {
    expect(renderCmsVideo({ ...youtube, title: "  A talk  " })).toContain(
      'title="A talk"',
    );
  });

  test("is lazy, fullscreen and 16:9", () => {
    const html = renderCmsVideo(youtube);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain("allowfullscreen");
    expect(html).toContain("aspect-ratio:16/9");
  });

  // A hand-written row must not be able to point the frame at a host of its
  // choosing, however it spells the attempt.
  test("renders nothing for an id that fails its provider's pattern", () => {
    expect(renderCmsVideo({ ...youtube, id: "../../evil" })).toBe("");
    expect(renderCmsVideo({ ...youtube, id: "short" })).toBe("");
    expect(renderCmsVideo({ ...youtube, id: '/"><script>' })).toBe("");
    expect(renderCmsVideo({ ...vimeo, id: "12ab" })).toBe("");
    expect(renderCmsVideo({ ...vimeo, id: "76979871/../../" })).toBe("");
  });

  test("renders nothing for an unknown provider", () => {
    expect(
      renderCmsVideo({
        ...youtube,
        provider: "dailymotion",
      } as unknown as VideoValue),
    ).toBe("");
  });

  test("renders nothing without a usable title", () => {
    expect(renderCmsVideo({ ...youtube, title: "" })).toBe("");
    expect(renderCmsVideo({ ...youtube, title: "   " })).toBe("");
    expect(
      renderCmsVideo({ ...youtube, title: undefined as unknown as string }),
    ).toBe("");
    expect(
      renderCmsVideo({ ...youtube, title: "x".repeat(MAX_ALT_LENGTH + 1) }),
    ).toBe("");
    expect(
      renderCmsVideo({ ...youtube, title: "x".repeat(MAX_ALT_LENGTH) }),
    ).not.toBe("");
  });

  test("renders nothing for a missing value", () => {
    expect(renderCmsVideo(undefined as unknown as VideoValue)).toBe("");
    expect(renderCmsVideo(null as unknown as VideoValue)).toBe("");
  });
});
