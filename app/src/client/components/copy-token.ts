/**
 * Copy the one-time export token.
 *
 * The raw token exists in one response and nowhere else — only its hash is
 * stored — and it is 43 characters with no spaces, so on a phone selecting it
 * by hand is a fiddly press-and-drag. The Copy button beside it is presentation
 * over the `<code>` the server already rendered: it reads that text, hands it
 * to the Clipboard API, and says "Copied" briefly.
 *
 * Not every browser grants the clipboard (it needs a secure context and a
 * permission), and a refusal must not leave the editor with no way to copy.
 * When the write is refused the token's text is selected instead, and the
 * button says how to finish the job by hand — the platform's own Copy (⌘C,
 * Ctrl+C or a long press) — so it is clear the copy did not happen. The
 * selected text is the fallback; the label never claims a copy that failed.
 *
 * The button ships hidden and this script reveals it: with JavaScript off it
 * would be a control that does nothing, and the token is still there to select
 * by hand. No storage, no request — a reload starts over.
 */

/** How long the button says "Copied" before it says "Copy" again. */
const COPIED_MS = 2000;

export const init = (): (() => void) => {
  const teardowns: (() => void)[] = [];

  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-copy-token]",
  )) {
    const token = button
      .closest("[data-token-row]")
      ?.querySelector<HTMLElement>("[data-export-token]");
    if (!token) continue;

    button.hidden = false;

    const label = button.textContent ?? "";
    let reset: ReturnType<typeof setTimeout> | undefined;

    // A Range over the <code>, not `select()` on an input: the token is text in
    // a paragraph, and the selection endpoints are its own contents.
    const selectToken = () => {
      const range = document.createRange();
      range.selectNodeContents(token);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    };

    // Say what happened, then go back to the rendered label.
    const say = (text: string) => {
      button.textContent = text;
      clearTimeout(reset);
      reset = setTimeout(() => {
        button.textContent = label;
      }, COPIED_MS);
    };

    // A refusal leaves the token selected for the editor to copy, but must not
    // leave the button saying "Copy" as if the click had worked.
    const refused = () => {
      selectToken();
      say("Selected — press ⌘C or Ctrl+C");
    };

    const onClick = () => {
      let written: Promise<void>;
      try {
        written = navigator.clipboard.writeText(token.textContent ?? "");
      } catch {
        // No clipboard at all (an insecure origin, an old browser).
        refused();
        return;
      }

      written.then(() => say("Copied")).catch(refused);
    };

    button.addEventListener("click", onClick);
    teardowns.push(() => {
      button.removeEventListener("click", onClick);
      clearTimeout(reset);
    });
  }

  return () => {
    for (const teardown of teardowns) teardown();
  };
};
