import { describe, expect, test } from "bun:test";
import { block, pageType, slot, text } from "../../fields";
import { type SiteDefinitions, validateDefinitions } from "./publish";

const hero = block("hero", { heading: text() }, () => null);

describe("validateDefinitions", () => {
  test("accepts a well-formed set", () => {
    expect(() =>
      validateDefinitions({
        blocks: [hero],
        slots: [slot("home.hero", hero)],
        pageTypes: [pageType("Landing", { allowedBlocks: [hero] })],
      }),
    ).not.toThrow();
  });

  test("accepts an empty set", () => {
    expect(() => validateDefinitions({})).not.toThrow();
  });

  test("rejects a definition in the wrong collection, naming it", () => {
    const wrong = {
      blocks: [slot("home.hero", hero)],
    } as unknown as SiteDefinitions;

    expect(() => validateDefinitions(wrong)).toThrow(
      /only block definitions, but found "slot" \("home\.hero"\)/,
    );
  });

  test("rejects two definitions with the same name", () => {
    const duplicate = block("hero", {}, () => null);
    expect(() => validateDefinitions({ blocks: [hero, duplicate] })).toThrow(
      /Duplicate block type "hero"/,
    );
  });
});
