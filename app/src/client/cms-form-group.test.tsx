import { afterEach, describe, expect, test } from "bun:test";
import type { FieldMetadata } from "@alexpricedev/billet-cms/contract";
import { group, image, list, text } from "@alexpricedev/billet-cms/fields";
import { renderToString } from "preact-render-to-string";
import { FieldControl } from "../server/components/cms/field-control";
import { buildContent, init } from "./cms-form";

/**
 * The server's own control, read back by the client's own walker.
 *
 * The two halves of a field kind are written in different files and only ever
 * meet in a browser, so hand-written markup in a client test proves the walker
 * against a fixture rather than against what the CMS actually renders. Here the
 * form is the real component's output, so a change to either side that stops
 * them agreeing fails.
 */
const roundTrip = (
  field: FieldMetadata,
  value: unknown,
): Record<string, unknown> => {
  const html = renderToString(
    <FieldControl field={field} value={value} hasMedia pickerCapped={false} />,
  );
  document.body.innerHTML = `<form data-cms-form><input type="hidden" data-cms-content value="{}">${html}</form>`;
  init();
  return buildContent(document.querySelector("form") as HTMLFormElement);
};

const form = () => document.querySelector("form") as HTMLFormElement;

const click = (target: Element) => {
  target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
};

const fill = (control: Element, value: string) => {
  const input = control.querySelector<HTMLInputElement>("[data-text-input]");
  if (input) input.value = value;
};

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("a group renders and reads back as one object", () => {
  const cta = group({ label: text(), href: text() }).metadata("cta");

  test("round-trips its children into a nested object", () => {
    expect(roundTrip(cta, { label: "Go", href: "/pricing" })).toEqual({
      cta: { label: "Go", href: "/pricing" },
    });
  });

  // Without the `[data-group-fields]` guard in `readFieldsIn`, a group's
  // children are `[data-field]` descendants of the form too, so they land at
  // the top level under their own names as well — content the block's schema
  // rejects, from a form that looked right.
  test("does not also report its children as the block's own fields", () => {
    const content = roundTrip(cta, { label: "Go", href: "/pricing" });

    expect(Object.keys(content)).toEqual(["cta"]);
    expect(content.label).toBeUndefined();
    expect(content.href).toBeUndefined();
  });

  // An empty list already reads back as `[]` rather than vanishing, so an
  // untouched group reads back as `{}`. Keeping the convention is what makes
  // the schema's complaint useful: `{}` fails on the children the editor
  // actually left blank, where an absent `cta` would only say "cta is
  // required" about a fieldset they can see.
  test("reads an untouched group as an empty object", () => {
    expect(roundTrip(cta, undefined)).toEqual({ cta: {} });
  });

  test("keeps a partly filled group", () => {
    expect(roundTrip(cta, { label: "Go" })).toEqual({ cta: { label: "Go" } });
  });
});

describe("a list of groups", () => {
  const steps = list(group({ title: text(), body: text() }), {
    label: "Steps",
  }).metadata("steps");

  // The shape `list()` alone could not hold: the pairing is what makes it
  // worth having, so it is what the test asserts.
  test("keeps each row's fields together", () => {
    expect(
      roundTrip(steps, [
        { title: "One", body: "First" },
        { title: "Two", body: "Second" },
      ]),
    ).toEqual({
      steps: [
        { title: "One", body: "First" },
        { title: "Two", body: "Second" },
      ],
    });
  });

  test("drops a row the editor added and left blank", () => {
    expect(roundTrip(steps, [{ title: "One", body: "First" }, {}])).toEqual({
      steps: [{ title: "One", body: "First" }],
    });
  });

  test("reads an empty list as no rows, the way it always has", () => {
    expect(roundTrip(steps, [])).toEqual({ steps: [] });
  });

  // The path an editor actually takes. The template a row is cloned from holds
  // a whole group, so this is the one place the clone has to carry a subtree
  // rather than a single control.
  test("adds a row from the template and keeps its fields paired", () => {
    roundTrip(steps, [{ title: "One", body: "First" }]);

    const list = form().querySelector('[data-field-name="steps"]') as Element;
    click(list.querySelector(":scope > [data-list-add]") as Element);

    const rows = Array.from(
      list.querySelectorAll(":scope > [data-list-items] > [data-list-item]"),
    );
    expect(rows).toHaveLength(2);

    const added = rows[1].querySelector(":scope > [data-field]") as Element;
    const children = Array.from(
      added.querySelectorAll(":scope > [data-group-fields] > [data-field]"),
    );
    expect(children.map((c) => c.getAttribute("data-field-name"))).toEqual([
      "title",
      "body",
    ]);

    fill(children[0], "Two");
    fill(children[1], "Second");

    expect(buildContent(form())).toEqual({
      steps: [
        { title: "One", body: "First" },
        { title: "Two", body: "Second" },
      ],
    });
  });

  test("a row added and left blank is not stored", () => {
    roundTrip(steps, [{ title: "One", body: "First" }]);

    const list = form().querySelector('[data-field-name="steps"]') as Element;
    click(list.querySelector(":scope > [data-list-add]") as Element);

    expect(buildContent(form())).toEqual({
      steps: [{ title: "One", body: "First" }],
    });
  });
});

describe("a group nested in a group", () => {
  const outer = group({
    heading: text(),
    inner: group({ label: text() }),
  }).metadata("outer");

  test("reads each group's own children, not the other's", () => {
    expect(
      roundTrip(outer, { heading: "Top", inner: { label: "Deep" } }),
    ).toEqual({ outer: { heading: "Top", inner: { label: "Deep" } } });
  });

  // The collapse happens at every depth below the top: the inner group is
  // dropped from the outer rather than stored as a nested blank, so a list of
  // these can still recognise a row as untouched.
  test("collapses an all-empty tree to one empty object", () => {
    expect(roundTrip(outer, { inner: {} })).toEqual({ outer: {} });
  });
});

describe("a group holding an image", () => {
  const card = group({ caption: text(), photo: image() }).metadata("card");

  test("round-trips the media reference", () => {
    expect(
      roundTrip(card, {
        caption: "A photo",
        photo: { mediaId: MEDIA_ID, alt: "Alt text" },
      }),
    ).toEqual({
      card: {
        caption: "A photo",
        photo: { mediaId: MEDIA_ID, alt: "Alt text" },
      },
    });
  });
});
