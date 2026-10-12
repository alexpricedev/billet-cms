import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DefinitionsLoadError, loadDefinitions } from "./load";

const fixture = (name: string): string =>
  join(import.meta.dir, "fixtures", name);

describe("loadDefinitions", () => {
  test("loads a site config's named definitions", async () => {
    const definitions = await loadDefinitions(fixture("site-config.ts"));

    expect(definitions.blocks?.map(({ name }) => name)).toEqual(["hero"]);
    expect(definitions.slots?.map(({ name }) => name)).toEqual(["home.hero"]);
    expect(definitions.pageTypes?.map(({ name }) => name)).toEqual(["landing"]);
  });

  test("stops with the path when the config can't be imported", async () => {
    const missing = fixture("does-not-exist.ts");

    try {
      await loadDefinitions(missing);
      throw new Error("expected loadDefinitions to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DefinitionsLoadError);
      expect((error as Error).message).toContain(missing);
    }
  });
});
