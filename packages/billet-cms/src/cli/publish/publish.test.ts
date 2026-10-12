import { describe, expect, test } from "bun:test";
import type { PageTypeDefinition } from "../../fields";
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

  test("rejects a slot filled by a block this publish doesn't declare", () => {
    const other = block("other", {}, () => null);
    expect(() =>
      validateDefinitions({
        blocks: [hero],
        slots: [slot("home.other", other)],
      }),
    ).toThrow(
      /Slot "home\.other" is filled by block "other", which this publish doesn't declare/,
    );
  });

  test("rejects a page type that allows an undeclared block", () => {
    const other = block("other", {}, () => null);
    expect(() =>
      validateDefinitions({
        blocks: [hero],
        pageTypes: [pageType("Landing", { allowedBlocks: [other] })],
      }),
    ).toThrow(
      /Page type "Landing" references block "other", which this publish doesn't declare/,
    );
  });

  test("rejects a page type that requires an undeclared block", () => {
    const other = block("other", {}, () => null);
    // `pageType()` won't build this (a required block must be allowed), but a
    // config is plain data by the time the publish sees it — the validator has
    // to check the required list too, not just the allowed one.
    const handWritten = {
      kind: "pageType",
      name: "Landing",
      allowedBlocks: [hero],
      requiredBlocks: [other],
      limits: {},
    } as unknown as PageTypeDefinition;

    expect(() =>
      validateDefinitions({ blocks: [hero], pageTypes: [handWritten] }),
    ).toThrow(
      /Page type "Landing" references block "other", which this publish doesn't declare/,
    );
  });
});
