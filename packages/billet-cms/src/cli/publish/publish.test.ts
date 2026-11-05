import { describe, expect, test } from "bun:test";
import type { PageTypeDefinition, SectionDefinition } from "../../fields";
import { block, pageType, section, slot, text } from "../../fields";
import { type SiteDefinitions, validateDefinitions } from "./publish";

const hero = block("hero", { label: "Hero" }, { heading: text() }, () => null);

describe("validateDefinitions", () => {
  test("accepts a well-formed set", () => {
    expect(() =>
      validateDefinitions({
        blocks: [hero],
        slots: [slot("home.hero", hero)],
        pageTypes: [pageType("landing", { allowedBlocks: [hero] })],
      }),
    ).not.toThrow();
  });

  test("accepts a set of explicit empty arrays", () => {
    // A site with no blocks exports `blocks = []` rather than omitting the key.
    expect(() =>
      validateDefinitions({
        blocks: [],
        pageTypes: [],
        slots: [],
        sections: [],
      }),
    ).not.toThrow();
  });

  test("accepts a well-formed section and omits it from a config that has none", () => {
    const journal = section("journal", { paths: ["/journal/**"] });

    expect(() =>
      validateDefinitions({
        blocks: [],
        pageTypes: [],
        slots: [],
        sections: [journal],
      }),
    ).not.toThrow();
    // Sections are optional: an absent key means the site declares none.
    expect(() =>
      validateDefinitions({ blocks: [], pageTypes: [], slots: [] }),
    ).not.toThrow();
  });

  test("rejects two sections with the same name", () => {
    const one = section("journal", { paths: ["/journal/**"] });
    const two = section("journal", { paths: ["/news/**"] });

    expect(() =>
      validateDefinitions({
        blocks: [],
        pageTypes: [],
        slots: [],
        sections: [one, two],
      }),
    ).toThrow(/Duplicate section "journal"/);
  });

  test("rejects a section in the sections collection that isn't a section", () => {
    expect(() =>
      validateDefinitions({
        blocks: [],
        pageTypes: [],
        slots: [],
        sections: [slot("home.hero", hero)] as unknown as SectionDefinition[],
      }),
    ).toThrow(/only section definitions, but found "slot" \("home\.hero"\)/);
  });

  test("rejects a config that declares none of blocks, pageTypes or slots", () => {
    expect(() => validateDefinitions({})).toThrow(
      /declares none of blocks, pageTypes or slots/,
    );
  });

  test("rejects a collection that isn't an array, naming it", () => {
    const notAnArray = { blocks: "hero" } as unknown as SiteDefinitions;
    expect(() => validateDefinitions(notAnArray)).toThrow(
      /Expected "blocks" in the CMS config to be an array, but it is string/,
    );
  });

  test("rejects a non-array collection on each key", () => {
    for (const key of ["blocks", "pageTypes", "slots"]) {
      const wrong = { [key]: {} } as unknown as SiteDefinitions;
      expect(() =>
        validateDefinitions({
          blocks: [],
          pageTypes: [],
          slots: [],
          ...wrong,
        }),
      ).toThrow(new RegExp(`"${key}" in the CMS config to be an array`));
    }
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
    const duplicate = block("hero", { label: "Hero" }, {}, () => null);
    expect(() => validateDefinitions({ blocks: [hero, duplicate] })).toThrow(
      /Duplicate block type "hero"/,
    );
  });

  test("rejects a slot filled by a block this publish doesn't declare", () => {
    const other = block("other", { label: "Other" }, {}, () => null);
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
    const other = block("other", { label: "Other" }, {}, () => null);
    expect(() =>
      validateDefinitions({
        blocks: [hero],
        pageTypes: [pageType("landing", { allowedBlocks: [other] })],
      }),
    ).toThrow(
      /Page type "landing" references block "other", which this publish doesn't declare/,
    );
  });

  test("rejects a page type that requires an undeclared block", () => {
    const other = block("other", { label: "Other" }, {}, () => null);
    // `pageType()` won't build this (a required block must be allowed), but a
    // config is plain data by the time the publish sees it — the validator has
    // to check the required list too, not just the allowed one.
    const handWritten = {
      kind: "pageType",
      name: "landing",
      allowedBlocks: [hero],
      requiredBlocks: [other],
      limits: {},
    } as unknown as PageTypeDefinition;

    expect(() =>
      validateDefinitions({ blocks: [hero], pageTypes: [handWritten] }),
    ).toThrow(
      /Page type "landing" references block "other", which this publish doesn't declare/,
    );
  });
});
