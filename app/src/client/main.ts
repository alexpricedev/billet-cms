import { Dialog } from "@alexpricedev/billet-dialog";
import { init as initCopyToken } from "@client/components/copy-token";
import { init as initFlashDismiss } from "@client/components/flash-dismiss";
import { init as initNavMenu } from "@client/components/nav-menu";
import { init as initPreviewGuard } from "@client/components/preview-guard";
import { initializePage } from "@client/page-lifecycle";
import * as ui from "@client/reactive";

// The nav is on every page, so it runs outside the per-data-page registry.
initNavMenu();

// Flash banners ship their × hidden; reveal it and let it close the banner.
initFlashDismiss();

// The export token's Copy button copies the <code> beside it; the button ships
// hidden so a page without JavaScript has no control that does nothing.
initCopyToken();

// A form carrying `data-confirm` asks before it posts; every other form, and
// every form without JavaScript, posts as it always did.
Dialog.wireForms();

// Preview posts the last saved revision, so pressing it with unsaved edits on
// screen shows older words. On a CMS form, ask first and offer the save.
initPreviewGuard();

initializePage(document.body.dataset.page);
ui.mount();
