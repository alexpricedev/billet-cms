import { describe, expect, test } from "bun:test";
import {
  normaliseVideoContent,
  parseVideoUrl,
  VIDEO_TITLE_MESSAGE,
  VIDEO_URL_MESSAGE,
  type VideoProvider,
  videoEmbedUrl,
} from "./video";

const YOUTUBE = "dQw4w9WgXcQ";
const VIMEO = "76979871";

describe("parseVideoUrl", () => {
  const accepted: [label: string, url: string, provider: VideoProvider][] = [
    ["youtube.com watch", `https://youtube.com/watch?v=${YOUTUBE}`, "youtube"],
    [
      "www.youtube.com watch",
      `https://www.youtube.com/watch?v=${YOUTUBE}`,
      "youtube",
    ],
    [
      "m.youtube.com watch",
      `https://m.youtube.com/watch?v=${YOUTUBE}`,
      "youtube",
    ],
    [
      "a watch link with a start time and playlist (both dropped)",
      `https://www.youtube.com/watch?v=${YOUTUBE}&t=42s&list=PL123`,
      "youtube",
    ],
    ["youtu.be", `https://youtu.be/${YOUTUBE}`, "youtube"],
    [
      "youtu.be with a share id (dropped)",
      `https://youtu.be/${YOUTUBE}?si=x`,
      "youtube",
    ],
    ["embed", `https://www.youtube.com/embed/${YOUTUBE}`, "youtube"],
    [
      "an embed with a start time (dropped)",
      `https://www.youtube.com/embed/${YOUTUBE}?start=10`,
      "youtube",
    ],
    ["shorts", `https://www.youtube.com/shorts/${YOUTUBE}`, "youtube"],
    ["live", `https://www.youtube.com/live/${YOUTUBE}`, "youtube"],
    [
      "the privacy-enhanced embed host",
      `https://www.youtube-nocookie.com/embed/${YOUTUBE}`,
      "youtube",
    ],
    ["vimeo.com", `https://vimeo.com/${VIMEO}`, "vimeo"],
    [
      "vimeo.com with a share parameter (dropped)",
      `https://vimeo.com/${VIMEO}?share=copy`,
      "vimeo",
    ],
    ["the vimeo player", `https://player.vimeo.com/video/${VIMEO}`, "vimeo"],
  ];

  for (const [label, url, provider] of accepted) {
    test(`accepts ${label}`, () => {
      expect(parseVideoUrl(url)).toEqual({
        provider,
        id: provider === "youtube" ? YOUTUBE : VIMEO,
      });
    });
  }

  test("trims surrounding whitespace from a pasted link", () => {
    expect(parseVideoUrl(`  https://youtu.be/${YOUTUBE}\n`)).toEqual({
      provider: "youtube",
      id: YOUTUBE,
    });
  });

  const refused: [label: string, url: string][] = [
    ["an empty value", ""],
    ["only whitespace", "   "],
    ["a page that is not a video", "https://example.com/watch?v=dQw4w9WgXcQ"],
    ["another video service", `https://example.org/video/${VIMEO}`],
    ["a playlist with no video", "https://www.youtube.com/playlist?list=PL123"],
    [
      "a youtube id of the wrong length",
      "https://www.youtube.com/watch?v=short",
    ],
    [
      "a youtube id carrying a path",
      "https://www.youtube.com/embed/dQw4w9WgXcQ/extra",
    ],
    ["a vimeo id that is not digits", "https://vimeo.com/not-a-number"],
    ["an unlisted vimeo link", `https://vimeo.com/${VIMEO}/abc123`],
    [
      "an unlisted vimeo player link",
      `https://player.vimeo.com/video/${VIMEO}?h=abc123`,
    ],
    [
      "a lookalike youtube host",
      `https://youtube.com.evil.example/watch?v=${YOUTUBE}`,
    ],
    ["a javascript: url", "javascript:alert(1)"],
    ["a data: url", "data:text/html,<p>hi</p>"],
    ["http rather than https", `http://www.youtube.com/watch?v=${YOUTUBE}`],
    ["a scheme-less address", `youtu.be/${YOUTUBE}`],
  ];

  for (const [label, url] of refused) {
    test(`refuses ${label}`, () => {
      expect(parseVideoUrl(url)).toBeNull();
    });
  }
});

describe("videoEmbedUrl", () => {
  test("builds a YouTube embed on the privacy-enhanced host", () => {
    expect(videoEmbedUrl({ provider: "youtube", id: YOUTUBE })).toBe(
      `https://www.youtube-nocookie.com/embed/${YOUTUBE}`,
    );
  });

  test("builds a Vimeo embed that asks not to be tracked", () => {
    expect(videoEmbedUrl({ provider: "vimeo", id: VIMEO })).toBe(
      `https://player.vimeo.com/video/${VIMEO}?dnt=1`,
    );
  });

  test("returns nothing for an id that carries a path", () => {
    expect(videoEmbedUrl({ provider: "youtube", id: `${YOUTUBE}/evil` })).toBe(
      "",
    );
    expect(videoEmbedUrl({ provider: "vimeo", id: `${VIMEO}?x=1` })).toBe("");
  });

  test("returns nothing for a provider that is not one of the two", () => {
    expect(
      videoEmbedUrl({ provider: "other" as unknown as VideoProvider, id: "1" }),
    ).toBe("");
  });
});

describe("normaliseVideoContent", () => {
  const clip = { name: "clip", kind: "video", required: true };

  test("turns the form's url and title into the stored shape", () => {
    const result = normaliseVideoContent([clip], {
      clip: { url: `https://youtu.be/${YOUTUBE}`, title: "  A talk  " },
    });

    expect(result.issues).toEqual([]);
    expect(result.content).toEqual({
      clip: { provider: "youtube", id: YOUTUBE, title: "A talk" },
    });
  });

  test("leaves an already-stored value for the schema to check", () => {
    const stored = { provider: "vimeo", id: VIMEO, title: "A talk" };
    const result = normaliseVideoContent([clip], { clip: stored });
    expect(result.issues).toEqual([]);
    expect(result.content).toEqual({ clip: stored });
  });

  test("names the link box when the pasted url is not a video", () => {
    const result = normaliseVideoContent([clip], {
      clip: { url: "https://example.com/holiday", title: "Holiday" },
    });

    expect(result.issues).toEqual([
      { path: "clip.url", message: VIDEO_URL_MESSAGE },
    ]);
    // The typed values survive, so the editor can correct the link rather than
    // retype the title.
    expect(result.content).toEqual({
      clip: { url: "https://example.com/holiday", title: "Holiday" },
    });
  });

  test("names the title box when the video has no title", () => {
    const result = normaliseVideoContent([clip], {
      clip: { url: `https://vimeo.com/${VIMEO}`, title: "   " },
    });

    expect(result.issues).toEqual([
      { path: "clip.title", message: VIDEO_TITLE_MESSAGE },
    ]);
    expect(result.content).toEqual({
      clip: { url: `https://vimeo.com/${VIMEO}`, title: "   " },
    });
  });

  test("names the link box when a required video was left blank", () => {
    const result = normaliseVideoContent([clip], {
      clip: { url: "", title: "" },
    });

    expect(result.issues).toEqual([
      { path: "clip.url", message: VIDEO_URL_MESSAGE },
    ]);
  });

  test("drops an optional video that was left blank", () => {
    const result = normaliseVideoContent(
      [{ name: "clip", kind: "video", required: false }],
      { clip: { url: "", title: "" }, heading: "Hello" },
    );

    expect(result.issues).toEqual([]);
    expect(result.content).toEqual({ heading: "Hello" });
  });

  test("leaves a value that is not an object alone", () => {
    const result = normaliseVideoContent([clip], { clip: "nope" });
    expect(result.issues).toEqual([]);
    expect(result.content).toEqual({ clip: "nope" });
  });

  test("carries a key no field declares through to the schema", () => {
    const result = normaliseVideoContent([clip], {
      clip: { url: `https://youtu.be/${YOUTUBE}`, title: "A talk" },
      extra: true,
    });
    expect(result.content).toEqual({
      clip: { provider: "youtube", id: YOUTUBE, title: "A talk" },
      extra: true,
    });
  });

  test("returns non-object content unchanged", () => {
    expect(normaliseVideoContent([clip], null)).toEqual({
      content: null,
      issues: [],
    });
  });

  test("finds a video in each list item and names the failing index", () => {
    const fields = [
      {
        name: "clips",
        kind: "list",
        required: true,
        of: { name: "item", kind: "video", required: true },
      },
    ];

    const good = normaliseVideoContent(fields, {
      clips: [
        { url: `https://youtu.be/${YOUTUBE}`, title: "One" },
        { url: `https://vimeo.com/${VIMEO}`, title: "Two" },
      ],
    });
    expect(good.issues).toEqual([]);
    expect(good.content).toEqual({
      clips: [
        { provider: "youtube", id: YOUTUBE, title: "One" },
        { provider: "vimeo", id: VIMEO, title: "Two" },
      ],
    });

    const bad = normaliseVideoContent(fields, {
      clips: [
        { url: `https://youtu.be/${YOUTUBE}`, title: "One" },
        { url: "not a link", title: "Two" },
      ],
    });
    expect(bad.issues).toEqual([
      { path: "clips.1.url", message: VIDEO_URL_MESSAGE },
    ]);
  });

  test("finds a video inside a group", () => {
    const fields = [
      {
        name: "feature",
        kind: "group",
        required: true,
        fields: [
          { name: "heading", kind: "text", required: true },
          { name: "clip", kind: "video", required: true },
        ],
      },
    ];

    const result = normaliseVideoContent(fields, {
      feature: {
        heading: "Watch this",
        clip: {
          url: `https://www.youtube.com/watch?v=${YOUTUBE}`,
          title: "A talk",
        },
      },
    });

    expect(result.issues).toEqual([]);
    expect(result.content).toEqual({
      feature: {
        heading: "Watch this",
        clip: { provider: "youtube", id: YOUTUBE, title: "A talk" },
      },
    });

    const bad = normaliseVideoContent(fields, {
      feature: { heading: "Watch this", clip: { url: "", title: "" } },
    });
    expect(bad.issues).toEqual([
      { path: "feature.clip.url", message: VIDEO_URL_MESSAGE },
    ]);
  });

  test("drops an optional video inside a group without dropping the group", () => {
    const result = normaliseVideoContent(
      [
        {
          name: "feature",
          kind: "group",
          required: true,
          fields: [
            { name: "heading", kind: "text", required: true },
            { name: "clip", kind: "video", required: false },
          ],
        },
      ],
      { feature: { heading: "Watch this", clip: { url: "", title: "" } } },
    );

    expect(result.issues).toEqual([]);
    expect(result.content).toEqual({ feature: { heading: "Watch this" } });
  });

  test("finds a video in a group repeated by a list", () => {
    const fields = [
      {
        name: "rows",
        kind: "list",
        required: true,
        of: {
          name: "item",
          kind: "group",
          required: true,
          fields: [{ name: "clip", kind: "video", required: true }],
        },
      },
    ];

    const result = normaliseVideoContent(fields, {
      rows: [
        { clip: { url: `https://vimeo.com/${VIMEO}`, title: "A talk" } },
        { clip: { url: "https://example.com", title: "Nope" } },
      ],
    });

    expect(result.issues).toEqual([
      { path: "rows.1.clip.url", message: VIDEO_URL_MESSAGE },
    ]);
  });

  test("does not mutate the content it was given", () => {
    const content = {
      clip: { url: `https://youtu.be/${YOUTUBE}`, title: "A talk" },
    };
    normaliseVideoContent([clip], content);
    expect(content.clip.url).toBe(`https://youtu.be/${YOUTUBE}`);
  });
});
