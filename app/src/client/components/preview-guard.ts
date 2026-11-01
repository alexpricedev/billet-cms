import { Dialog } from "@alexpricedev/billet-dialog";

/**
 * Hold Preview until what the editor typed is actually saved.
 *
 * Preview is its own form: it posts the subject's id and nothing else, so the
 * token it mints covers the last *saved* revision. Pressed with unsaved edits
 * on screen it opens a tab showing older words with nothing on the page to say
 * why — the confusion this exists to remove.
 *
 * So: the first edit marks the form dirty, and a Preview pressed while it is
 * dirty asks first. Confirming saves instead, carrying `after=preview` so the
 * save finishes the job and redirects on to the preview the editor asked for;
 * cancelling leaves them exactly where they were, with the draft untouched.
 *
 * The save is submitted, in this tab, rather than fetched or sent from the
 * preview's: a background save would leave this page's `base_revision` behind
 * the revision it just created, and publishing refuses anything that is not
 * the newest — so the editor's next click would be refused over their own save.
 *
 * It lands on the preview in this tab rather than a new one for a duller
 * reason: a save is a navigation, and a `target="_blank"` form submitted after
 * one has no user gesture behind it, so the browser blocks the tab. The
 * unprompted Preview button still opens a tab, because that click *is* the
 * gesture; only the path through a save gives it up.
 *
 * It lives here rather than in `cms-form.ts` because that bundle has a byte
 * budget, and this is page chrome rather than anything to do with serialising
 * a block's content. Without JavaScript nothing changes: Preview posts as it
 * always did, and shows the last saved draft.
 */
export const init = (): (() => void) => {
  const form = document.querySelector<HTMLFormElement>("[data-cms-form]");
  const preview = document.querySelector<HTMLButtonElement>(
    "[data-preview-submit]",
  );
  const after = form?.querySelector<HTMLInputElement>("[data-save-after]");
  if (!form || !preview || !after) return () => {};

  // The server renders Preview disabled when there is no draft, and when the
  // draft is already the live revision: from a clean page there is nothing
  // unpublished to preview. Unsaved edits *are* an unpublished change, and
  // Preview is a save followed by a preview, so the first edit opens the
  // button and drops the server's reason; a submit puts both back. Off, the
  // button stays disabled and the reason stays as rendered.
  const reason = document.querySelector<HTMLElement>("[data-preview-reason]");
  const wasDisabled = preview.disabled;
  const describedBy = preview.getAttribute("aria-describedby");
  const reasonText = reason?.textContent ?? "";

  let dirty = false;
  const markDirty = () => {
    if (dirty) return;
    dirty = true;
    if (!wasDisabled) return;
    preview.disabled = false;
    preview.removeAttribute("aria-describedby");
    if (reason) reason.textContent = "";
  };
  // The save is what makes the form clean again, and this page is on its way
  // out — but a validation failure re-renders it, so the flag has to reset.
  const markClean = () => {
    dirty = false;
    if (!wasDisabled) return;
    preview.disabled = true;
    if (describedBy) preview.setAttribute("aria-describedby", describedBy);
    if (reason) reason.textContent = reasonText;
  };

  const onClick = (event: Event) => {
    if (!dirty) return;
    event.preventDefault();

    void Dialog.confirm({
      title: "Save this draft first?",
      message:
        "Preview shows the last saved draft, so the changes you just made would not appear. Saving opens the preview in this tab; the banner there links back.",
      confirmLabel: "Save and preview",
      cancelLabel: "Keep editing",
      danger: false,
    }).then((confirmed) => {
      if (!confirmed) return;
      after.value = "preview";
      // requestSubmit, not submit: it runs the form's own submit handler, which
      // is what serialises the editor's content into the hidden field.
      form.requestSubmit();
    });
  };

  form.addEventListener("input", markDirty);
  form.addEventListener("change", markDirty);
  form.addEventListener("submit", markClean);
  preview.addEventListener("click", onClick);

  return () => {
    form.removeEventListener("input", markDirty);
    form.removeEventListener("change", markDirty);
    form.removeEventListener("submit", markClean);
    preview.removeEventListener("click", onClick);
  };
};
